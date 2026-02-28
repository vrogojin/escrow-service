import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const { Sphere } = await import('@unicitylabs/sphere-sdk');
  const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

  const providers = createNodeProviders({
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'dev',
    dataDir: config.sphereWalletPath,
    tokensDir: `${config.sphereWalletPath}/tokens`,
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  const identity = sphere.identity!;
  const escrowAddress = identity.directAddress ?? `DIRECT://${identity.chainPubkey}`;

  if (created && generatedMnemonic) {
    console.log('\n========================================');
    console.log('  NEW ESCROW WALLET CREATED');
    console.log('========================================\n');
    console.log(`  Address : ${escrowAddress}`);
    console.log(`  Network : ${config.sphereNetwork}`);
    console.log(`  Wallet  : ${config.sphereWalletPath}\n`);
    console.log('  MNEMONIC (back this up securely!):');
    console.log(`  ${generatedMnemonic}\n`);
    console.log('========================================\n');

    const backupPath = join(config.sphereWalletPath, 'mnemonic.backup');
    writeFileSync(backupPath, generatedMnemonic + '\n', { mode: 0o600 });
    console.log(`Mnemonic saved to ${backupPath} (permissions: 0600)`);
  } else {
    console.log(`Wallet already exists at ${config.sphereWalletPath}`);
    console.log(`  Address : ${escrowAddress}`);
    console.log(`  Network : ${config.sphereNetwork}`);
  }

  await sphere.destroy();
}

main().catch((err) => {
  console.error('Failed to initialize wallet:', err);
  process.exit(1);
});
