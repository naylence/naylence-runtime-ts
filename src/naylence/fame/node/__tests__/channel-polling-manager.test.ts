import type { FameDeliveryContext, FameEnvelope, FameMessageResponse } from "naylence-core";
import { FameResponseType, extractEnvelopeAndContext, isFameMessageResponse } from "naylence-core";

import { ChannelPollingManager } from "../channel-polling-manager.js";
import { FameTransportClose } from "../../errors/errors.js";
import { TaskTimeoutError } from "../../util/task-types.js";
import type { ReadWriteChannel } from "naylence-core";
import type { ResponseContextManager } from "../response-context-manager.js";
import type { StreamingResponseHandler } from "../streaming-response-handler.js";

jest.mock("../../util/logging.js", () => ({
  __esModule: true,
  getLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../util/envelope-context.js", () => ({
  __esModule: true,
  withEnvelopeContextAsync: jest.fn(async (_envelope: FameEnvelope, fn: () => unknown) => fn()),
}));

jest.mock("naylence-core", () => {
  const actual = jest.requireActual("naylence-core");
  return {
    __esModule: true,
    ...actual,
    extractEnvelopeAndContext: jest.fn(),
    isFameMessageResponse: jest.fn(),
  };
});

const withEnvelopeContextAsync = require("../../util/envelope-context.js")
  .withEnvelopeContextAsync as jest.MockedFunction<
  typeof import("../../util/envelope-context.js").withEnvelopeContextAsync
>;

const extractEnvelopeAndContextMock = extractEnvelopeAndContext as jest.MockedFunction<
  typeof extractEnvelopeAndContext
>;

const isFameMessageResponseMock = isFameMessageResponse as jest.MockedFunction<
  typeof isFameMessageResponse
>;

interface ManagerDeps {
  deliverWrapper: jest.Mock;
  deliverFn: jest.Mock;
  responseContextManager: ResponseContextManager;
  streamingResponseHandler: StreamingResponseHandler;
  streamingResponseHandlerMocks: {
    isStreamingFameMessageResponse: jest.Mock;
    handleStreamingFameMessageResponses: jest.Mock;
  };
}

function createDeps(): ManagerDeps {
  const deliverFn = jest.fn().mockResolvedValue(undefined);
  const deliverWrapper = jest.fn(() => deliverFn);
  const responseContextManager: ResponseContextManager = {
    createResponseContext: jest.fn(
      () =>
        ({
          expectedResponseType: FameResponseType.ACK,
          created: true,
        }) as unknown as FameDeliveryContext
    ),
    ensureResponseMetadata: jest.fn(),
  } as unknown as ResponseContextManager;

  const streamingResponseHandlerMocks = {
    isStreamingFameMessageResponse: jest.fn((_result: unknown) => false),
    handleStreamingFameMessageResponses: jest.fn().mockResolvedValue(undefined),
  };

  const streamingResponseHandler = {
    isStreamingFameMessageResponse:
      streamingResponseHandlerMocks.isStreamingFameMessageResponse as unknown as StreamingResponseHandler["isStreamingFameMessageResponse"],
    handleStreamingFameMessageResponses:
      streamingResponseHandlerMocks.handleStreamingFameMessageResponses as unknown as StreamingResponseHandler["handleStreamingFameMessageResponses"],
  } as StreamingResponseHandler;

  return {
    deliverWrapper,
    deliverFn,
    responseContextManager,
    streamingResponseHandler,
    streamingResponseHandlerMocks,
  };
}

function createChannel(...implementations: Array<() => Promise<unknown>>): ReadWriteChannel {
  const receive = jest.fn();
  implementations.forEach((impl) => receive.mockImplementationOnce(impl));
  return {
    receive,
  } as unknown as ReadWriteChannel;
}

describe("ChannelPollingManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withEnvelopeContextAsync.mockImplementation(async (_envelope, fn) => fn());
  });

  it("delivers message responses using created response context", async () => {
    const { deliverWrapper, deliverFn, responseContextManager, streamingResponseHandler } =
      createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const requestEnvelope = { id: "req-1" } as FameEnvelope;
    const requestContext = {
      expectedResponseType: FameResponseType.ACK,
      ctx: "request",
    } as unknown as FameDeliveryContext;
    const responseEnvelope = { id: "resp-1" } as FameEnvelope;
    const response: FameMessageResponse = {
      envelope: responseEnvelope,
    } as FameMessageResponse;

    extractEnvelopeAndContextMock.mockReturnValue([requestEnvelope, requestContext]);
    isFameMessageResponseMock.mockReturnValue(true);

    const handler = jest.fn(async () => response);

    const stopState = { stopped: false };

    const channel = createChannel(
      async () => ({ envelope: "message" }),
      async () => {
        stopState.stopped = true;
        return undefined;
      }
    );

    await manager.startPollingLoop("service-A", channel, handler, stopState, 5);

    expect(responseContextManager.createResponseContext).toHaveBeenCalledWith(
      requestEnvelope,
      requestContext
    );
    expect(responseContextManager.ensureResponseMetadata).toHaveBeenCalledWith(
      responseEnvelope,
      requestEnvelope,
      expect.objectContaining({ created: true })
    );
    expect(deliverWrapper).toHaveBeenCalledTimes(1);
    expect(deliverFn).toHaveBeenCalledWith(
      responseEnvelope,
      expect.objectContaining({ created: true })
    );
  });

  it("reuses provided response context when delivering", async () => {
    const { deliverWrapper, deliverFn, responseContextManager, streamingResponseHandler } =
      createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const requestEnvelope = { id: "req-2" } as FameEnvelope;
    const providedContext = {
      expectedResponseType: FameResponseType.ACK,
      ctx: "existing",
    } as unknown as FameDeliveryContext;
    const responseEnvelope = { id: "resp-2" } as FameEnvelope;
    const response: FameMessageResponse = {
      envelope: responseEnvelope,
      context: providedContext,
    } as FameMessageResponse;

    extractEnvelopeAndContextMock.mockReturnValue([requestEnvelope, undefined]);
    isFameMessageResponseMock.mockReturnValue(true);

    const handler = jest.fn(async () => response);
    const stopState = { stopped: false };

    const channel = createChannel(
      async () => ({ envelope: "message" }),
      async () => {
        stopState.stopped = true;
        return undefined;
      }
    );

    await manager.startPollingLoop("service-B", channel, handler, stopState);

    expect(responseContextManager.createResponseContext).not.toHaveBeenCalled();
    expect(responseContextManager.ensureResponseMetadata).toHaveBeenCalledWith(
      responseEnvelope,
      requestEnvelope,
      providedContext
    );
    expect(deliverFn).toHaveBeenCalledWith(responseEnvelope, providedContext);
  });

  it("delegates streaming responses to the streaming handler", async () => {
    const {
      deliverFn,
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler,
      streamingResponseHandlerMocks,
    } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const result = { stream: true };
    const envelope = { id: "stream-req" } as FameEnvelope;

    isFameMessageResponseMock.mockReturnValue(false);
    streamingResponseHandlerMocks.isStreamingFameMessageResponse.mockReturnValue(true);

    await (manager as unknown as { processHandlerResult: Function }).processHandlerResult(
      result,
      envelope,
      undefined,
      "stream-service"
    );

    expect(streamingResponseHandlerMocks.handleStreamingFameMessageResponses).toHaveBeenCalledWith(
      result,
      envelope,
      undefined
    );
    expect(deliverWrapper).not.toHaveBeenCalled();
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("ignores handler results that are not responses", async () => {
    const {
      deliverWrapper,
      deliverFn,
      responseContextManager,
      streamingResponseHandler,
      streamingResponseHandlerMocks,
    } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    isFameMessageResponseMock.mockReturnValue(false);
    streamingResponseHandlerMocks.isStreamingFameMessageResponse.mockReturnValue(false);

    await (manager as unknown as { processHandlerResult: Function }).processHandlerResult(
      { other: "value" },
      { id: "req-ignore" } as FameEnvelope,
      undefined,
      "ignore-service"
    );

    expect(deliverWrapper).not.toHaveBeenCalled();
    expect(deliverFn).not.toHaveBeenCalled();
    expect(
      streamingResponseHandlerMocks.handleStreamingFameMessageResponses
    ).not.toHaveBeenCalled();
  });

  it("propagates handler failures", async () => {
    const { deliverWrapper, responseContextManager, streamingResponseHandler } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const channel = createChannel(async () => ({ payload: "message" }));

    const expectedError = new Error("handler failed");

    extractEnvelopeAndContextMock.mockReturnValue([{ id: "req" } as FameEnvelope, undefined]);
    isFameMessageResponseMock.mockReturnValue(true);

    await expect(
      manager.startPollingLoop(
        "failure-service",
        channel,
        async () => {
          throw expectedError;
        },
        { stopped: false }
      )
    ).rejects.toThrow(expectedError);
  });

  async function expectLoopToResolveForError(error: unknown): Promise<void> {
    const { deliverWrapper, responseContextManager, streamingResponseHandler } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const stopState = { stopped: false };

    const channel = createChannel(async () => {
      throw error;
    });

    await manager.startPollingLoop("svc", channel, jest.fn(), stopState);
  }

  async function expectLoopToContinueForError(error: unknown): Promise<void> {
    const { deliverWrapper, responseContextManager, streamingResponseHandler } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const stopState = { stopped: false };

    const channel = createChannel(
      async () => {
        throw error;
      },
      async () => {
        stopState.stopped = true;
        return undefined;
      }
    );

    await manager.startPollingLoop("svc", channel, jest.fn(), stopState);
  }

  async function expectLoopToRejectForError(error: unknown): Promise<void> {
    const { deliverWrapper, responseContextManager, streamingResponseHandler } = createDeps();

    const manager = new ChannelPollingManager(
      deliverWrapper,
      responseContextManager,
      streamingResponseHandler
    );

    const channel = createChannel(async () => {
      throw error;
    });

    await expect(
      manager.startPollingLoop("svc", channel, jest.fn(), { stopped: false })
    ).rejects.toThrow(error as Error);
  }

  it("stops polling when the transport is closed", async () => {
    await expectLoopToResolveForError(new FameTransportClose("closed"));
  });

  it("continues polling when TaskTimeoutError is thrown", async () => {
    await expectLoopToContinueForError(new TaskTimeoutError("timed out"));
  });

  it("throws when AbortError is encountered", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    await expectLoopToRejectForError(abortError);
  });

  it("continues polling when TimeoutError is encountered by name", async () => {
    const timeoutError = new Error("timeout");
    timeoutError.name = "TimeoutError";

    await expectLoopToContinueForError(timeoutError);
  });

  it("stops polling when channel reports it is closed", async () => {
    await expectLoopToResolveForError(new Error("Channel is closed"));
  });

  it("throws when TaskCancelledError is encountered", async () => {
    const cancelledError = new Error("cancelled");
    cancelledError.name = "TaskCancelledError";

    await expectLoopToRejectForError(cancelledError);
  });

  it("continues polling when a timeout message is received", async () => {
    await expectLoopToContinueForError(new Error("operation Timeout reached"));
  });

  it("stops polling when an error message indicates closure", async () => {
    await expectLoopToResolveForError(new Error("connection closed unexpectedly"));
  });

  it("logs and stops polling when an unknown error occurs", async () => {
    await expectLoopToResolveForError(new Error("unexpected failure"));
  });
});
