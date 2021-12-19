import * as apigw from "@aws-cdk/aws-apigatewayv2";
import * as apigwInt from "@aws-cdk/aws-apigatewayv2-integrations";
import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as lambda from "@aws-cdk/aws-lambda";
import * as nodeLambda from "@aws-cdk/aws-lambda-nodejs";
import * as path from "path";

export interface OrderServiceStackProps extends cdk.StackProps {
  customDomainName: string;
  cidr: string;
}

export class OrdersServiceStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: OrderServiceStackProps) {
    super(scope, id, props);

    // create the vpc with one private subnets in two AZs
    const vpc: ec2.Vpc = new ec2.Vpc(this, "order-vpc", {
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

    // create the 'create-order' lambda
    const handler: nodeLambda.NodejsFunction = new nodeLambda.NodejsFunction(
      this,
      "create-order",
      {
        functionName: "create-order",
        runtime: lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, "/../orders/create-order/create-order.ts"),
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

    // create an http api with a lambda proxy
    const httpApi: apigw.HttpApi = new apigw.HttpApi(this, "orders-http-api");
    const createOrderLambdaIntegration: apigwInt.LambdaProxyIntegration =
      new apigwInt.LambdaProxyIntegration({
        handler: handler,
      });

    // add an orders route
    httpApi.addRoutes({
      path: "/orders",
      methods: [apigw.HttpMethod.POST],
      integration: createOrderLambdaIntegration,
    });

    // add some outputs to use later
    new cdk.CfnOutput(this, "OrdersEndpointUrl", {
      value: `${httpApi.url}orders`,
      exportName: "OrdersEndpointUrl",
    });
  }
}
