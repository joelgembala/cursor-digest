// All current external adapters use fetch. Fail if the demo reaches any adapter.
globalThis.fetch = async () => { throw new Error('Network access is disabled in the portfolio demo'); };
