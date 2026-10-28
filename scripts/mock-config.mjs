export function mockPatch(port) {
  return `- id: agent-default-model
  config:
    provider: wsl-poc
    model: poc-model
- id: llm-pi-ai
  config:
    providers:
      wsl-poc:
        displayName: WSL POC 本地模拟
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: DSH_WSL_POC_MOCK_KEY
        models:
          - id: poc-model
            name: WSL POC 本地模拟
            contextWindow: 65536
            reasoningEfforts: false
- id: tool-bash
  disabled: false
- id: session-title-llm
  disabled: true
`;
}
