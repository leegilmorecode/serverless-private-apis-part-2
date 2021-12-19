#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "@aws-cdk/core";

import {
  StockServiceStack,
  StockServiceStackProps,
} from "../lib/stock-service-stack";

const props: StockServiceStackProps = {
  certificateArn:
    "arn:aws:acm:us-east-1:your-account-id:certificate/certificate-id",
  customDomainName: "stock.yourdomain.co.uk",
  cidr: "10.2.0.0/16",
  region: "us-east-1",
};

const app = new cdk.App();
new StockServiceStack(app, "stock-service-stack", props);
