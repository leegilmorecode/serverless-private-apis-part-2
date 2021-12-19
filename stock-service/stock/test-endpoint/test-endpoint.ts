import axios from "axios";

type Stock = {
  stockId: number;
  description: string;
};

type StockResponse = {
  stock: Stock[];
};

async function handler(): Promise<{ body: string; statusCode: number }> {
  const domain = process.env.STOCK_DOMAIN;

  console.log(
    `test-endpoint.handler - started call too: https://${domain}/prod/stock`
  );

  const result = await axios.get(
    `https://${domain}/prod/stock`, // this is the private api dns entry
    {
      headers: {
        "x-api-key": "super-secret-api-key", // this is the api key for our private api
      },
    }
  );

  const data: StockResponse = result.data;

  console.log(
    `test-endpoint.handler - private call via https://${domain}/prod/stock is successful: ${data}`
  );

  return {
    body: JSON.stringify(data),
    statusCode: 200,
  };
}

module.exports = { handler };
