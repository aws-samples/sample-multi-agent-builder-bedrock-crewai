import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CodeBuildStep, CodePipeline, CodePipelineSource} from 'aws-cdk-lib/pipelines';
import { MultiAgentProjectStage } from './multi-agent-toolchain-stages';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MultiAgentToolchainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      env: {
        account: scope.node.tryGetContext('account'),
        region: scope.node.tryGetContext('region')
      }
    });
    
    const pipelineSource = CodePipelineSource.connection(
      this.node.tryGetContext('user') + '/' + this.node.tryGetContext('repo'),
      this.node.tryGetContext('branch'),
      {
        connectionArn: this.node.tryGetContext('connection'),
      }
    );

    const synthStep = new CodeBuildStep('Synth', {
      input: pipelineSource,
      buildEnvironment: {
        environmentVariables: {
          CONNECTION_ARN: { value: this.node.tryGetContext('connection')},
          GITHUB_USER: { value: this.node.tryGetContext('user')},
          GITHUB_REPO: { value: this.node.tryGetContext('repo')},
          GITHUB_BRANCH: { value: this.node.tryGetContext('branch')},
          ACCOUNT_ID: { value: this.node.tryGetContext('account')},
          REGION: { value: this.node.tryGetContext('region')},
        }
      },      
      commands: [
        // Install dependencies
        'npm ci',
        // Build UI with the generated config
        'cd ui',
        'npm i',
        'npm run build',
        'cd ..',
        // Build TypeScript
        'npm run build',
        // Install latest CDK CLI globally
        'npm install -g aws-cdk@latest',
        // Clear context.json from Github
        'rm -rf cdk.context.json',
        // Create a new context file with the current account and region
        'cat > cdk.context.json << EOF\n{"account": "$ACCOUNT_ID", "region": "$REGION", "connection": "$CONNECTION_ARN", "user": "$GITHUB_USER", "repo": "$GITHUB_REPO", "branch": "$GITHUB_BRANCH"}\nEOF',
        // Synthesize CDK using the new context file
        'cdk synth',
      ],
      rolePolicyStatements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${this.account}:role/cdk-*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:GetObjectVersion',
            's3:PutObject',
            's3:GetBucketVersioning'
          ],
          resources: [
            `arn:aws:s3:::cdk-*`,
            `arn:aws:s3:::cdk-*/*`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codecommit:CancelUploadArchive',
            'codecommit:GetBranch',
            'codecommit:GetCommit',
            'codecommit:GetRepository',
            'codecommit:ListBranches',
            'codecommit:ListRepositories'
          ],
          resources: [
            `arn:aws:codecommit:${this.region}:${this.account}:${this.node.tryGetContext('repo')}`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codebuild:CreateReportGroup',
            'codebuild:CreateReport',
            'codebuild:UpdateReport',
            'codebuild:BatchPutTestCases',
            'codebuild:BatchPutCodeCoverages'
          ],
          resources: [
            `arn:aws:codebuild:${this.region}:${this.account}:report-group/*`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'codepipeline:PutJobSuccessResult',
            'codepipeline:PutJobFailureResult'
          ],
          resources: ['*'], // CodePipeline job tokens are dynamic
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeStackEvents',
            'cloudformation:DescribeStackResources',
            'cloudformation:DescribeStackResource'
          ],
          resources: [
            `arn:aws:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`,
            `arn:aws:cloudformation:${this.region}:${this.account}:stack/*MultiAgent*/*`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*`
          ],
        })
      ]
    });

    // Create the pipeline with the updated synthStep
    const pipeline = new CodePipeline(this, 'MultiAgentPipeline', {
      pipelineName: 'MultiAgentProjectPipeline',
      synth: synthStep
    });

    const deploy = new MultiAgentProjectStage(this, 'Deploy', {
      env: {
        account: scope.node.tryGetContext('account'),
        region: scope.node.tryGetContext('region')
      }
    });

    const deployStage = pipeline.addStage(deploy);

    // Add a post-deployment step to generate config and build UI
    deployStage.addPost(new CodeBuildStep('DeployUI', {
      commands: [
        'npm ci',
        'npm run generate-config',
        'cat .env',
        // Copy .env to UI directory
        'cp .env ui/.env',
        'echo "Copied .env to ui/.env"',
        'cat ui/.env',
        // Build UI with the generated config
        'cd ui',
        'npm i',
        'npm run build',
        'cd ..',
        // Find the S3 bucket name from SSM or CloudFormation outputs
        'export UI_BUCKET=$(aws ssm get-parameter --name "/multi-agent/ui-bucket" --query "Parameter.Value" --output text || aws cloudformation describe-stacks --stack-name Deploy-MultiAgentProjectStack --query "Stacks[0].Outputs[?OutputKey==\'UIBucketName\'].OutputValue" --output text)',
        'echo "UI Bucket: $UI_BUCKET"',
        // Upload UI build to S3
        'aws s3 sync ui/build/ s3://$UI_BUCKET --delete',
        // Create CloudFront invalidation
        'export CF_DIST_ID=$(aws ssm get-parameter --name "/multi-agent/cf-distribution" --query "Parameter.Value" --output text || aws cloudformation describe-stacks --stack-name Deploy-MultiAgentProjectStack --query "Stacks[0].Outputs[?OutputKey==\'CloudFrontDistributionId\'].OutputValue" --output text)',
        'echo "CloudFront Distribution ID: $CF_DIST_ID"',
        'aws cloudfront create-invalidation --distribution-id $CF_DIST_ID --paths "/*"',
      ],
      rolePolicyStatements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/multi-agent/*`,
            `arn:aws:ssm:${this.region}:${this.account}:parameter/api/endpoint`,
            `arn:aws:ssm:${this.region}:${this.account}:parameter/agent-api/endpoint`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:PutObject',
            's3:GetObject',
            's3:DeleteObject',
            's3:ListBucket'
          ],
          resources: [
            `arn:aws:s3:::multi-agent-ui-bucket-${this.account}`,
            `arn:aws:s3:::multi-agent-ui-bucket-${this.account}/*`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${this.account}:distribution/*`
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudformation:DescribeStacks'],
          resources: [
            `arn:aws:cloudformation:${this.region}:${this.account}:stack/Deploy-MultiAgentProjectStack/*`
          ],
        })
      ]
    }));
  }
}