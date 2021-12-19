import * as apigw from "@aws-cdk/aws-apigateway";
import * as awsLambda from "@aws-cdk/aws-lambda-nodejs";
import * as cdk from "@aws-cdk/core";
import * as certManager from "@aws-cdk/aws-certificatemanager";
import * as customResources from "@aws-cdk/custom-resources";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as elbTargets from "@aws-cdk/aws-elasticloadbalancingv2-targets";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as iam from "@aws-cdk/aws-iam";
import * as lambda from "@aws-cdk/aws-lambda";
import * as path from "path";
import * as route53 from "@aws-cdk/aws-route53";
import * as targets from "@aws-cdk/aws-route53-targets";

export interface StockServiceStackProps extends cdk.StackProps {
  certificateArn: string;
  customDomainName: string;
  cidr: string;
  region: string;
}

export class StockServiceStack extends cdk.Stack {
  private vpcEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly stockLoadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: cdk.Construct, id: string, props: StockServiceStackProps) {
    super(scope, id, props);

    // create the vpc with one private subnet in two AZs
    const vpc: ec2.Vpc = new ec2.Vpc(this, "stock-vpc", {
      cidr: props.cidr,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "private-subnet-1",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // create the 'get-stock' lambda
    const handler: awsLambda.NodejsFunction = new awsLambda.NodejsFunction(
      this,
      "get-stock",
      {
        functionName: "get-stock",
        runtime: lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, "/../stock/get-stock/get-stock.ts"),
        memorySize: 1024,
        handler: "handler",
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
        },
        environment: {
          STOCK_DOMAIN: props.customDomainName,
          REGION: cdk.Stack.of(this).region,
          AVAILABILITY_ZONES: JSON.stringify(
            cdk.Stack.of(this).availabilityZones
          ),
        },
      }
    );

    // this lambda only exists to test that the domain name is working in the same VPC (needs to be invoked in the console)
    new awsLambda.NodejsFunction(this, "test-endpoint", {
      functionName: "test-endpoint",
      runtime: lambda.Runtime.NODEJS_14_X,
      entry: path.join(__dirname, "/../stock/test-endpoint/test-endpoint.ts"),
      memorySize: 1024,
      handler: "handler",
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
      },
      environment: {
        STOCK_DOMAIN: props.customDomainName,
        REGION: cdk.Stack.of(this).region,
        AVAILABILITY_ZONES: JSON.stringify(
          cdk.Stack.of(this).availabilityZones
        ),
      },
    });

    // add a security group for the vpc endpoint
    const sg: ec2.SecurityGroup = new ec2.SecurityGroup(this, "stock-vpc-sg", {
      vpc,
      allowAllOutbound: true,
      securityGroupName: "stock-vpc-sg",
    });

    sg.addIngressRule(ec2.Peer.ipv4(props.cidr), ec2.Port.tcp(443));

    // create the vpc endpoint
    this.vpcEndpoint = new ec2.InterfaceVpcEndpoint(
      this,
      "stock-api-vpc-endpoint",
      {
        vpc,
        service: {
          name: `com.amazonaws.${props.region}.execute-api`,
          port: 443,
        },
        subnets: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }),
        privateDnsEnabled: true,
        securityGroups: [sg],
      }
    );

    // add the resource policy for the private api
    const apiResourcePolicy: iam.PolicyDocument = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["execute-api:Invoke"],
          principals: [new iam.AnyPrincipal()],
          resources: ["execute-api:/*/*/*"], //this will automatically populate on deploy
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["execute-api:Invoke"],
          resources: ["execute-api:/*/*/*"], //this will automatically populate on deploy
          conditions: {
            StringNotEquals: {
              "aws:SourceVpce": this.vpcEndpoint.vpcEndpointId,
            },
          },
        }),
      ],
    });

    // create the private api for the stock platform
    const api: apigw.RestApi = new apigw.RestApi(this, "stock-platform-api", {
      restApiName: "stock-platform-api",
      endpointConfiguration: {
        types: [apigw.EndpointType.PRIVATE],
      },
      policy: apiResourcePolicy,
    });

    // create a rate limit key for the usage plan
    const key: apigw.RateLimitedApiKey = new apigw.RateLimitedApiKey(
      this,
      "orders-rate-limited-api-key",
      {
        enabled: true,
        apiKeyName: "orders-rate-limited-api-key",
        description: "orders-rate-limited-api-key",
        customerId: "orders-api",
        value: "super-secret-api-key",
        generateDistinctId: false,
        resources: [api],
        quota: {
          limit: 500,
          period: apigw.Period.DAY,
        },
      }
    );

    // add a usage plan for the api
    const plan: apigw.UsagePlan = api.addUsagePlan("orders-usage-plan", {
      name: "orders-usage-plan",
      throttle: {
        rateLimit: 10,
        burstLimit: 2,
      },
    });

    plan.addApiKey(key);

    // add a lambda integration to the api
    const getStockLambda: apigw.LambdaIntegration = new apigw.LambdaIntegration(
      handler,
      {
        allowTestInvoke: true,
      }
    );

    // add the stock resources to the api
    const stock: apigw.Resource = api.root.addResource("stock");
    const stockMethod: apigw.Method = stock.addMethod("GET", getStockLambda, {
      authorizationType: apigw.AuthorizationType.NONE,
      apiKeyRequired: true,
    });

    // and the api stage
    plan.addApiStage({
      stage: api.deploymentStage,
      throttle: [
        {
          method: stockMethod,
          throttle: {
            rateLimit: 10,
            burstLimit: 2,
          },
        },
      ],
    });

    // create an internal application load balancer
    this.stockLoadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "stock-internal-elb",
      {
        vpc,
        http2Enabled: false,
        loadBalancerName: "stock-internal-elb",
        vpcSubnets: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }),
        internetFacing: false,
      }
    );

    // ensure the vpc endpoint only accepts connections from the load balancer
    this.vpcEndpoint.connections.allowFrom(
      this.stockLoadBalancer,
      ec2.Port.tcp(443)
    );

    // create the application target group
    const targetGroup: elbv2.ApplicationTargetGroup =
      new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
        vpc: vpc,
        targetType: elbv2.TargetType.IP,
        port: 443,
      });

    // use a custom resource to get the private ip addresses based on the vpc endpoints
    for (let index = 0; index < vpc.availabilityZones.length; index++) {
      const getEndpointIp: customResources.AwsCustomResource =
        new customResources.AwsCustomResource(this, `GetEndpointIp${index}`, {
          onUpdate: {
            service: "EC2",
            action: "describeNetworkInterfaces",
            physicalResourceId: customResources.PhysicalResourceId.fromResponse(
              `NetworkInterfaces.${index}.PrivateIpAddress`
            ),
            parameters: {
              NetworkInterfaceIds:
                this.vpcEndpoint.vpcEndpointNetworkInterfaceIds,
            },
          },
          policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
            resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        });
      targetGroup.addTarget(
        new elbTargets.IpTarget(
          cdk.Token.asString(
            getEndpointIp.getResponseField(
              `NetworkInterfaces.${index}.PrivateIpAddress`
            )
          )
        )
      );
    }

    // add a listener with the correct cert
    this.stockLoadBalancer.addListener("Listener", {
      certificateArns: [props.certificateArn],
      port: 443,
      defaultTargetGroups: [targetGroup],
    });

    // add a healthcheck for 403
    targetGroup.configureHealthCheck({
      healthyHttpCodes: "403",
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      path: "/",
      protocol: elbv2.Protocol.HTTPS,
    });

    // create a private hosted zone
    const zone: route53.PrivateHostedZone = new route53.PrivateHostedZone(
      this,
      "stock-private-hosted-zone",
      {
        zoneName: props.customDomainName,
        vpc,
        comment: "private hosted zone for stock internally",
      }
    );

    // add a record set to the private hosted zone
    new route53.RecordSet(this, "stock-record-set", {
      recordType: route53.RecordType.A,
      zone: zone,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.stockLoadBalancer)
      ),
      comment: "stock internal api",
      recordName: props.customDomainName,
      ttl: cdk.Duration.minutes(0),
    });

    // add a custom domain to the stock api gateway
    const customDomain: apigw.DomainName = new apigw.DomainName(
      this,
      "customDomain",
      {
        domainName: props.customDomainName,
        certificate: certManager.Certificate.fromCertificateArn(
          this,
          "stock-acm-certificate",
          props.certificateArn
        ),
        endpointType: apigw.EndpointType.REGIONAL,
      }
    );

    // add a base mapping to the custom domain
    customDomain.addBasePathMapping(api, { basePath: "prod" });

    // outputs
    new cdk.CfnOutput(this, "StockEndpointUrl", {
      value: `${api.url}stock`,
      exportName: "StockEndpointUrl",
    });

    new cdk.CfnOutput(this, "OrdersVPCEndpointId", {
      value: this.vpcEndpoint.vpcEndpointId,
      exportName: "OrdersVPCEndpointId",
    });
  }
}
