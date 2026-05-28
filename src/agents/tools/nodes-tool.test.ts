import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  resolveNode: vi.fn(async () => ({ nodeId: "node-1", remoteIp: "127.0.0.1" })),
}));

const nodesCameraMocks = vi.hoisted(() => ({
  cameraTempPath: vi.fn(({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.jpg` : "/tmp/camera.jpg",
  ),
  parseCameraClipPayload: vi.fn(),
  parseCameraSnapPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "jpg",
    width: 800,
    height: 600,
  })),
  writeCameraClipPayloadToFile: vi.fn(),
  writeCameraPayloadToFile: vi.fn(async () => undefined),
}));

const screenMocks = vi.hoisted(() => ({
  parseScreenRecordPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 300_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  })),
  screenRecordTempPath: vi.fn(() => "/tmp/screen-record.mp4"),
  writeScreenRecordToFile: vi.fn(async () => ({ path: "/tmp/screen-record.mp4" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  resolveNode: nodeUtilsMocks.resolveNode,
}));

vi.mock("../../cli/nodes-camera.js", () => ({
  cameraTempPath: nodesCameraMocks.cameraTempPath,
  parseCameraClipPayload: nodesCameraMocks.parseCameraClipPayload,
  parseCameraSnapPayload: nodesCameraMocks.parseCameraSnapPayload,
  writeCameraClipPayloadToFile: nodesCameraMocks.writeCameraClipPayloadToFile,
  writeCameraPayloadToFile: nodesCameraMocks.writeCameraPayloadToFile,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
}));

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;

function mockNodePairApproveFlow(pendingRequest: {
  requiredApproveScopes?: string[];
  commands?: string[];
}): void {
  gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
    if (method === "node.pair.list") {
      return {
        pending: [
          {
            requestId: "req-1",
            ...pendingRequest,
          },
        ],
      };
    }
    if (method === "node.pair.approve") {
      return { ok: true, method, params, extra };
    }
    throw new Error(`unexpected method: ${String(method)}`);
  });
}

function expectNodePairApproveScopes(scopes: string[]): void {
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    1,
    "node.pair.list",
    {},
    {},
    { scopes: ["operator.pairing"] },
  );
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    2,
    "node.pair.approve",
    {},
    { requestId: "req-1" },
    { scopes },
  );
}

describe("createNodesTool screen_record duration guardrails", () => {
  beforeAll(async () => {
    // The agents lane runs on the shared non-isolated runner, so clear any
    // cached prior import before wiring this file's gateway/media mocks.
    vi.resetModules();
    ({ createNodesTool } = await import("./nodes-tool.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
    nodeUtilsMocks.resolveNode.mockClear();
    screenMocks.parseScreenRecordPayload.mockClear();
    screenMocks.writeScreenRecordToFile.mockClear();
    nodesCameraMocks.cameraTempPath.mockClear();
    nodesCameraMocks.parseCameraSnapPayload.mockClear();
    nodesCameraMocks.writeCameraPayloadToFile.mockClear();
  });

  it("marks nodes as owner-only", () => {
    const tool = createNodesTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("bounds durationMs schema to positive values capped at 300000", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        durationMs?: {
          minimum?: number;
          maximum?: number;
          type?: string;
        };
      };
    };
    expect(schema.properties?.durationMs?.type).toBe("integer");
    expect(schema.properties?.durationMs?.minimum).toBe(1);
    expect(schema.properties?.durationMs?.maximum).toBe(300_000);
  });

  it("bounds photos_latest limit schema to positive values capped at 20", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        limit?: {
          minimum?: number;
          maximum?: number;
          type?: string;
        };
      };
    };
    expect(schema.properties?.limit?.type).toBe("integer");
    expect(schema.properties?.limit?.minimum).toBe(1);
    expect(schema.properties?.limit?.maximum).toBe(20);
  });

  it("clamps screen_record durationMs argument to 300000 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "screen_record",
      node: "macbook",
      durationMs: 900_000,
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        params: expect.objectContaining({
          durationMs: 300_000,
        }),
      }),
    );
  });

  it("clamps camera_clip durationMs argument to 300000 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    nodesCameraMocks.parseCameraClipPayload.mockReturnValue({
      base64: "ZmFrZQ==",
      format: "mp4",
      durationMs: 300_000,
      hasAudio: true,
    });
    nodesCameraMocks.writeCameraClipPayloadToFile.mockResolvedValue("/tmp/clip.mp4");
    const tool = createNodesTool();

    await tool.execute("call-clip", {
      action: "camera_clip",
      node: "macbook",
      durationMs: 900_000,
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { params?: { durationMs?: unknown } }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].params?.durationMs).toBe(300_000);
  });

  it.each([
    ["screen_record", 0],
    ["screen_record", 1.5],
    ["camera_clip", -1],
    ["camera_clip", "1sec"],
  ])("rejects invalid %s durationMs value %s", async (action, durationMs) => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-invalid-duration", {
        action,
        node: "macbook",
        durationMs,
      }),
    ).rejects.toThrow("durationMs must be a positive integer");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects the removed run action", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "run",
        node: "macbook",
      }),
    ).rejects.toThrow("Unknown action: run");
  });
  it("returns camera snaps via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "camera_snap",
      node: "macbook",
      facing: "front",
    });

    expect(result?.details).toEqual({
      snaps: [
        {
          facing: "front",
          path: "/tmp/camera-front.jpg",
          width: 800,
          height: 600,
        },
      ],
      media: {
        mediaUrls: ["/tmp/camera-front.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("returns latest photos via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        photos: [
          { base64: "ZmFrZQ==", format: "jpg", width: 800, height: 600, createdAt: "now" },
          { base64: "YmFy", format: "jpg", width: 1024, height: 768 },
        ],
      },
    });
    nodesCameraMocks.cameraTempPath
      .mockReturnValueOnce("/tmp/photo-1.jpg")
      .mockReturnValueOnce("/tmp/photo-2.jpg");
    nodesCameraMocks.parseCameraSnapPayload
      .mockReturnValueOnce({
        base64: "ZmFrZQ==",
        format: "jpg",
        width: 800,
        height: 600,
      })
      .mockReturnValueOnce({
        base64: "YmFy",
        format: "jpg",
        width: 1024,
        height: 768,
      });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "photos_latest",
      node: "macbook",
    });

    expect(result?.details).toEqual({
      photos: [
        {
          index: 0,
          path: "/tmp/photo-1.jpg",
          width: 800,
          height: 600,
          createdAt: "now",
        },
        {
          index: 1,
          path: "/tmp/photo-2.jpg",
          width: 1024,
          height: 768,
        },
      ],
      media: {
        mediaUrls: ["/tmp/photo-1.jpg", "/tmp/photo-2.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("rejects invalid photos_latest limit values before gateway invoke", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-photos-limit", {
        action: "photos_latest",
        node: "macbook",
        limit: 1.5,
      }),
    ).rejects.toThrow("limit must be a positive integer");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("caps photos_latest limit at 20 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { photos: [] } });
    const tool = createNodesTool();

    await tool.execute("call-photos-limit", {
      action: "photos_latest",
      node: "macbook",
      limit: 99,
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { params?: { limit?: unknown } }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].params?.limit).toBe(20);
  });

  it("uses operator.pairing plus operator.admin to approve exec-capable node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.admin"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.admin"]);
  });

  it("uses operator.pairing plus operator.write to approve non-exec node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.write"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
  });

  it("uses operator.pairing for commandless node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing"]);
  });

  it("falls back to command inspection when the gateway does not advertise required scopes", async () => {
    mockNodePairApproveFlow({
      commands: ["canvas.snapshot"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
  });

  it("blocks invokeCommand system.run so exec stays the only shell path", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "system.run",
      }),
    ).rejects.toThrow('invokeCommand "system.run" is reserved for shell execution');
  });

  it("keeps invoke pairing guidance for scope upgrade rejections", async () => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-123)"),
    );
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "device.status",
      }),
    ).rejects.toThrow(
      "pairing required before node invoke. Approve pairing request req-123 and retry.",
    );
  });
});
