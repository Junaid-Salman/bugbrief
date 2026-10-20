export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function verifyDemo(folder?: string): Promise<{ ok: boolean; results: CheckResult[] }>;
