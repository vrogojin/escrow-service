import { openSync, writeSync, closeSync, chmodSync, constants, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const walletPath = resolve(config.sphereWalletPath);

  const { Sphere } = await import('@unicitylabs/sphere-sdk');
  const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

  const providers = createNodeProviders({
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'dev',
    dataDir: walletPath,
    tokensDir: join(walletPath, 'tokens'),
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  const identity = sphere.identity;
  if (!identity) {
    throw new Error('Sphere initialized but identity is null — wallet may be corrupt');
  }
  const escrowAddress = identity.directAddress ?? `DIRECT://${identity.chainPubkey}`;

  if (created && !generatedMnemonic) {
    throw new Error(
      'CRITICAL: Wallet was created but no mnemonic was returned. ' +
      'The wallet may be irrecoverable. Check SDK version.',
    );
  }

  if (created && generatedMnemonic) {
    // Write mnemonic backup FIRST, before displaying anything
    const backupPath = join(walletPath, 'mnemonic.backup');

    // Ensure wallet directory has restricted permissions
    if (!existsSync(walletPath)) {
      mkdirSync(walletPath, { recursive: true, mode: 0o700 });
    }
    chmodSync(walletPath, 0o700);

    // Atomic-ish create with O_EXCL to prevent symlink attacks and overwrites
    const fd = openSync(
      backupPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, generatedMnemonic + '\n');
    } finally {
      closeSync(fd);
    }
    // Defense-in-depth: ensure permissions even if umask interfered
    chmodSync(backupPath, 0o600);

    console.log('\n========================================');
    console.log('  NEW ESCROW WALLET CREATED');
    console.log('========================================\n');
    console.log(`  Address : ${escrowAddress}`);
    console.log(`  Network : ${config.sphereNetwork}`);
    console.log(`  Wallet  : ${walletPath}\n`);
    console.log(`  Mnemonic backup saved to: ${backupPath}`);
    console.log('  Permissions: 0600 (owner-only read/write)\n');

    // Only display mnemonic interactively, never to piped stdout
    if (process.stdout.isTTY) {
      console.log('  MNEMONIC (back this up securely!):');
      console.log(`  ${generatedMnemonic}\n`);
    } else {
      console.log('  (mnemonic not displayed — stdout is not a terminal)');
      console.log(`  Read it from: ${backupPath}\n`);
    }

    console.log('========================================\n');
  } else {
    console.log(`Wallet already exists at ${walletPath}`);
    console.log(`  Address : ${escrowAddress}`);
    console.log(`  Network : ${config.sphereNetwork}`);
  }

  try {
    await sphere.destroy();
  } catch (destroyErr) {
    console.error(
      'Warning: wallet created successfully but cleanup failed:',
      destroyErr instanceof Error ? destroyErr.message : 'Unknown error',
    );
  }
}

main().catch((err) => {
  console.error(
    'Failed to initialize wallet:',
    err instanceof Error ? err.message : 'Unknown error',
  );
  process.exit(1);
});
