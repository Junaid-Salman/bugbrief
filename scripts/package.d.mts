export function listFiles(dir: string): string[];
export function checkPackage(files: string[], manifest: { icons?: Record<string, string>; content_security_policy?: unknown }, readText: (file: string) => string): string[];
export function run(): void;
export function storeCheck(): void;
