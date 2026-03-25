export interface Config {
  nodeEnv: string;
  logLevel: string;

  sphereWalletPath: string;
  sphereAddressIndex: number;
  sphereNetwork: string;
  sphereNametag: string;

  swapTimeoutMin: number;
  swapTimeoutMax: number;
  swapTimeoutDefault: number;

  maxPendingSwaps: number;
  dataDir: string;
}

export function loadConfig(): Config {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',

    sphereWalletPath: process.env.SPHERE_WALLET_PATH ?? './.sphere-escrow',
    sphereAddressIndex: parseInt(process.env.SPHERE_ADDRESS_INDEX ?? '0', 10),
    sphereNetwork: process.env.SPHERE_NETWORK ?? 'mainnet',
    sphereNametag: process.env.SPHERE_NAMETAG ?? '',

    swapTimeoutMin: parseInt(process.env.SWAP_TIMEOUT_MIN ?? '60', 10),
    swapTimeoutMax: parseInt(process.env.SWAP_TIMEOUT_MAX ?? '86400', 10),
    swapTimeoutDefault: parseInt(process.env.SWAP_TIMEOUT_DEFAULT ?? '3600', 10),

    maxPendingSwaps: parseInt(process.env.MAX_PENDING_SWAPS ?? '10000', 10),
    dataDir: process.env.ESCROW_DATA_DIR ?? './.escrow-data',
  };
}
