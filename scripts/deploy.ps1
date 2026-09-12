[CmdletBinding()]
param(
    [string]$Profile = 'sense-mcp',
    [ValidateSet('us-east-2')]
    [string]$Region = 'us-east-2',
    [string]$StackName = 'sense-mcp',
    [string]$McpResourceUrl = 'https://placeholder.invalid/mcp',
    [string]$PrimaryCallbackUrl = 'https://chatgpt.com/',
    [string]$PartnerCallbackUrl = 'https://chatgpt.com/',
    [string]$PrimaryKeyParameter = '/sense-mcp/primary/key',
    [string]$PartnerKeyParameter = '/sense-mcp/partner/key',
    [string]$BudgetEmail = '',
    [ValidateSet('false', 'true')]
    [string]$EnableWrites = 'false'
)

$primaryCallbackProvided = $PSBoundParameters.ContainsKey('PrimaryCallbackUrl')
$partnerCallbackProvided = $PSBoundParameters.ContainsKey('PartnerCallbackUrl')
$primaryKeyParameterProvided = $PSBoundParameters.ContainsKey('PrimaryKeyParameter')
$partnerKeyParameterProvided = $PSBoundParameters.ContainsKey('PartnerKeyParameter')
$budgetEmailProvided = $PSBoundParameters.ContainsKey('BudgetEmail')
$enableWritesProvided = $PSBoundParameters.ContainsKey('EnableWrites')
$mcpResourceUrlProvided = $PSBoundParameters.ContainsKey('McpResourceUrl')

$ErrorActionPreference = 'Stop'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path -LiteralPath $aws)) {
    throw "AWS CLI was not found at $aws"
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    $caller = (& $aws sts get-caller-identity --profile $Profile --region $Region --output json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or -not $caller.Account) {
        throw "Unable to verify AWS profile '$Profile'. Run: aws login --profile $Profile --region $Region"
    }

    $stackId = & $aws cloudformation list-stacks `
        --query "StackSummaries[?StackName=='$StackName' && StackStatus!='DELETE_COMPLETE'] | [0].StackId" `
        --output text `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing CloudFormation stacks' }

    if ($stackId -and $stackId -ne 'None') {
        $currentParameters = (& $aws cloudformation describe-stacks `
            --stack-name $StackName `
            --query 'Stacks[0].Parameters' `
            --output json `
            --profile $Profile `
            --region $Region | ConvertFrom-Json)
        if ($LASTEXITCODE -ne 0) { throw 'Unable to read existing stack parameters' }

        if (-not $primaryCallbackProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'PrimaryCallbackUrl'
            if ($existing) { $PrimaryCallbackUrl = $existing.ParameterValue }
        }
        if (-not $mcpResourceUrlProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'McpResourceUrl'
            if ($existing) { $McpResourceUrl = $existing.ParameterValue }
        }
        if (-not $partnerCallbackProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'PartnerCallbackUrl'
            if ($existing) { $PartnerCallbackUrl = $existing.ParameterValue }
        }
        if (-not $primaryKeyParameterProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'PrimaryKeyParameter'
            if ($existing) { $PrimaryKeyParameter = $existing.ParameterValue }
        }
        if (-not $partnerKeyParameterProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'PartnerKeyParameter'
            if ($existing) { $PartnerKeyParameter = $existing.ParameterValue }
        }
        if (-not $budgetEmailProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'BudgetEmail'
            if ($existing) { $BudgetEmail = $existing.ParameterValue }
        }
        if (-not $enableWritesProvided) {
            $existing = $currentParameters | Where-Object ParameterKey -eq 'EnableWrites'
            if ($existing) { $EnableWrites = $existing.ParameterValue }
        }
    }

    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run check
    if ($LASTEXITCODE -ne 0) { throw 'Local checks failed' }

    $artifactBucket = "sense-mcp-artifacts-$($caller.Account)-$Region"
    $existingBucket = & $aws s3api list-buckets `
        --query "Buckets[?Name=='$artifactBucket'].Name | [0]" `
        --output text `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect deployment artifact buckets' }
    if ($existingBucket -ne $artifactBucket) {
        & $aws s3api create-bucket `
            --bucket $artifactBucket `
            --create-bucket-configuration "LocationConstraint=$Region" `
            --profile $Profile `
            --region $Region | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unable to create the deployment artifact bucket' }
    }

    & $aws s3api put-public-access-block `
        --bucket $artifactBucket `
        --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to protect the deployment artifact bucket' }

    & $aws s3api put-bucket-encryption `
        --bucket $artifactBucket `
        --server-side-encryption-configuration 'file://config/artifact-encryption.json' `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to enable artifact-bucket encryption' }

    & $aws s3api put-bucket-lifecycle-configuration `
        --bucket $artifactBucket `
        --lifecycle-configuration 'file://config/artifact-lifecycle.json' `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure artifact expiration' }

    New-Item -ItemType Directory -Path '.aws' -Force | Out-Null
    & $aws cloudformation package `
        --template-file template.yaml `
        --s3-bucket $artifactBucket `
        --s3-prefix releases `
        --output-template-file .aws\packaged.yaml `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'CloudFormation packaging failed' }

    $parameters = @(
        "McpResourceUrl=$McpResourceUrl",
        "PrimaryCallbackUrl=$PrimaryCallbackUrl",
        "PartnerCallbackUrl=$PartnerCallbackUrl",
        "PrimaryKeyParameter=$PrimaryKeyParameter",
        "PartnerKeyParameter=$PartnerKeyParameter",
        "BudgetEmail=$BudgetEmail",
        "EnableWrites=$EnableWrites"
    )

    & $aws cloudformation deploy `
        --template-file .aws\packaged.yaml `
        --stack-name $StackName `
        --capabilities CAPABILITY_IAM `
        --parameter-overrides $parameters `
        --tags Project=sense-mcp ManagedBy=CloudFormation `
        --no-fail-on-empty-changeset `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'CloudFormation deployment failed' }

    & $aws cloudformation describe-stacks `
        --stack-name $StackName `
        --query 'Stacks[0].Outputs[].{Name:OutputKey,Value:OutputValue}' `
        --output table `
        --profile $Profile `
        --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read stack outputs' }
}
finally {
    Pop-Location
}
