// Calls the Host's existing public LLM service. Credentials stay inside its adapters.
export class ModelBroker {
  constructor(llm) { this.llm = llm; }
  async catalog() {
    const groups = [];
    for (const provider of this.llm.listProviders()) {
      if (provider.id === 'wsl-host') continue;
      try {
        const models = await this.llm.listModels(provider.id);
        if (models.length) groups.push({ provider: provider.id, name: provider.name, models: models.map(x => ({ id: x.id, name: x.name })) });
      } catch { groups.push({ provider: provider.id, name: provider.name, models: [], unavailable: true }); }
    }
    return { groups };
  }
  async prepare(selection) {
    const models = await this.llm.listModels(selection.provider);
    if (!models.some(x => x.id === selection.model)) throw new Error('所选模型在当前 Windows Host 中不可用');
    const info = await this.llm.resolveModelInfo(selection.provider, selection.model);
    // The first bridge version handles text/tool traffic; Linux image refs are not Windows files.
    return { provider: info.provider, id: info.id, name: info.name, inputModalities: ['text'],
      ...(info.context ? { context: info.context } : {}), ...(info.reasoning ? { reasoning: info.reasoning } : {}),
      ...(info.defaultMaxTokens ? { defaultMaxTokens: info.defaultMaxTokens } : {}) };
  }
  async *stream(selection, request, signal) {
    if (signal.aborted) throw new Error('模型请求已取消');
    if (request.provider !== 'wsl-host' || request.model !== selection.id || !Array.isArray(request.messages)) throw new Error('模型路由不匹配');
    const messages = request.messages.map(message => {
      if (message.content?.some(x => x.type === 'image' || x.type === 'file')) throw new Error('当前模型桥仅支持文本和工具消息');
      const source = message.source;
      return source?.kind === 'model' && source.provider === 'wsl-host'
        ? { ...message, source: { ...source, provider: selection.provider, model: selection.id } } : message;
    });
    const options = { provider: selection.provider, model: selection.id, messages, signal };
    for (const key of ['system', 'tools', 'toolHistory', 'temperature', 'maxTokens', 'stop', 'reasoningEffort', 'sessionId', 'purpose']) if (request[key] !== undefined) options[key] = request[key];
    for await (const chunk of this.llm.stream(options)) {
      if (signal.aborted) throw new Error('模型请求已取消');
      if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        const code = /^[A-Z0-9_:-]{1,80}$/.test(chunk.reason.failure?.code ?? '') ? chunk.reason.failure.code : 'HOST_MODEL_ERROR';
        yield { type: 'finish', reason: { kind: chunk.reason.kind, failure: { code, message: 'Windows 模型调用未完成：' + code } } };
      } else yield chunk;
    }
  }
}
