#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "@aws-cdk/core";

import {
  OrderServiceStackProps,
  OrdersServiceStack,
} from "../lib/orders-service-stack";

const props: OrderServiceStackProps = {
  customDomainName: "stock.yourdomain.co.uk",
  cidr: "10.1.0.0/16",
};

const app = new cdk.App();
new OrdersServiceStack(app, "orders-service-stack", props);
