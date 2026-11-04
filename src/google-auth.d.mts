export function googleToken(options?: {credentialsPath?: string;clientPath?:string;accessToken?:string;credentialsJson?:string;clientJson?:string;fetchImpl?:typeof fetch}): () => Promise<string>;
