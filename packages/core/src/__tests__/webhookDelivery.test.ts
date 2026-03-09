import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateWebhookDeliveryBackoffMs,
  createWebhookSignature,
  deliverWebhook
} from "../webhookDelivery.js";

afterEach(() => {
  delete process.env.LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS;
});

async function createResponseServer(statusCode: number, body: string): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode, { "content-type": "text/plain" });
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/hooks`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

describe("webhookDelivery", () => {
  it("creates stable signatures and exponential backoff", () => {
    expect(
      createWebhookSignature("whsec_test", "1700000000", '{"ok":true}')
    ).toBe(
      "85876387ad9d6be57a04653bc0729da757049f58afb10ba6cac3bedaecf4fda3"
    );

    expect(
      calculateWebhookDeliveryBackoffMs(1, {
        maxAttempts: 4,
        initialBackoffMs: 1_000,
        maxBackoffMs: 10_000
      })
    ).toBe(1_000);
    expect(
      calculateWebhookDeliveryBackoffMs(3, {
        maxAttempts: 4,
        initialBackoffMs: 1_000,
        maxBackoffMs: 10_000
      })
    ).toBe(4_000);
    expect(
      calculateWebhookDeliveryBackoffMs(5, {
        maxAttempts: 4,
        initialBackoffMs: 1_000,
        maxBackoffMs: 10_000
      })
    ).toBe(10_000);
  });

  it("classifies retryable and terminal webhook responses", async () => {
    const retryServer = await createResponseServer(500, "try again later");
    const disableServer = await createResponseServer(410, "gone");

    try {
      const retryOutcome = await deliverWebhook({
        deliveryId: "whdel_retry",
        deliveryUrl: retryServer.url,
        eventType: "linkedin.notifications.item.created",
        payloadJson: '{"id":"evt_retry"}',
        secret: "whsec_test",
        retryCount: 0,
        timeoutMs: 2_000
      });
      expect(retryOutcome).toMatchObject({
        outcome: "retry",
        responseStatus: 500,
        errorCode: "NETWORK_ERROR"
      });

      const disableOutcome = await deliverWebhook({
        deliveryId: "whdel_fail",
        deliveryUrl: disableServer.url,
        eventType: "linkedin.notifications.item.created",
        payloadJson: '{"id":"evt_fail"}',
        secret: "whsec_test",
        retryCount: 0,
        timeoutMs: 2_000
      });
      expect(disableOutcome).toMatchObject({
        outcome: "failed",
        responseStatus: 410,
        disableSubscription: true,
        errorCode: "ACTION_PRECONDITION_FAILED"
      });
    } finally {
      await retryServer.close();
      await disableServer.close();
    }
  });
});
