[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PrimaryEmail,
    [Parameter(Mandatory)]
    [string]$PartnerEmail,
    [string]$Profile = 'sense-mcp',
    [ValidateSet('us-east-2')]
    [string]$Region = 'us-east-2',
    [string]$StackName = 'sense-mcp'
)

$ErrorActionPreference = 'Stop'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$poolId = & $aws cloudformation describe-stacks `
    --stack-name $StackName `
    --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue | [0]' `
    --output text `
    --profile $Profile `
    --region $Region
if ($LASTEXITCODE -ne 0 -or -not $poolId) { throw 'Unable to find the deployed Cognito user pool' }

function Add-FamilyUser {
    param([string]$Username, [string]$Email)

    $existingUser = & $aws cognito-idp list-users `
        --user-pool-id $poolId `
        --profile $Profile `
        --region $Region `
        --query "Users[?Username=='$Username'].Username | [0]" `
        --output text
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect Cognito user '$Username'" }
    if ($existingUser -eq $Username) {
        Write-Host "Cognito user '$Username' already exists; left unchanged."
        return
    }

    & $aws cognito-idp admin-create-user `
        --user-pool-id $poolId `
        --username $Username `
        --user-attributes "Name=email,Value=$Email" 'Name=email_verified,Value=true' `
        --desired-delivery-mediums EMAIL `
        --query 'User.Username' `
        --output text `
        --profile $Profile `
        --region $Region | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to create Cognito user '$Username'" }
    Write-Host "Created Cognito user '$Username' and sent its temporary-password invitation."
}

Add-FamilyUser -Username 'primary' -Email $PrimaryEmail
Add-FamilyUser -Username 'partner' -Email $PartnerEmail
