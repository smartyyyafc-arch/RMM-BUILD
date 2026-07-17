import type {
  DeviceInfo,
  EnrollResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  JobResult,
  MetricsSample,
} from "@rmm/shared";

/** Thin HTTP client for the RMM server API using the global fetch. */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private agentToken: string | null
  ) {}

  setToken(token: string): void {
    this.agentToken = token;
  }

  async enroll(
    enrollmentToken: string,
    info: DeviceInfo,
    machineId: string
  ): Promise<EnrollResponse> {
    const res = await fetch(`${this.baseUrl}/api/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentToken, info, machineId }),
    });
    if (!res.ok) {
      throw new Error(`enroll failed: ${res.status} ${await safeText(res)}`);
    }
    return (await res.json()) as EnrollResponse;
  }

  async heartbeat(
    deviceId: string,
    info: DeviceInfo,
    metrics: MetricsSample
  ): Promise<HeartbeatResponse> {
    const body: HeartbeatRequest = { info, metrics };
    const res = await fetch(`${this.baseUrl}/api/agents/${deviceId}/heartbeat`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      throw new UnauthorizedError();
    }
    if (!res.ok) {
      throw new Error(`heartbeat failed: ${res.status} ${await safeText(res)}`);
    }
    return (await res.json()) as HeartbeatResponse;
  }

  async reportJobResult(deviceId: string, jobId: string, result: JobResult): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/agents/${deviceId}/jobs/${jobId}/result`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(result),
    });
    if (!res.ok) {
      throw new Error(`job result failed: ${res.status} ${await safeText(res)}`);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.agentToken ?? ""}`,
    };
  }
}

/** Raised when the server rejects the agent token, signalling re-enrollment. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
