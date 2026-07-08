import { openSync, writeSync, closeSync, chmodSync, constants, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';

const NAMETAG_PATTERN = /^[a-z0-9][a-z0-9_-]{2,19}$/;

function validateNametag(raw: string): string {
  // Strip leading @ if operator mistakenly included it
  const nametag = raw.replace(/^@/, '').toLowerCase();
  if (!NAMETAG_PATTERN.test(nametag)) {
    throw new Error(
      `Invalid SPHERE_NAMETAG "${raw}": must be 3-20 chars, lowercase alphanumeric/underscore/hyphen only`,
    );
  }
  return nametag;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const walletPath = resolve(config.sphereWalletPath);

  // Validate nametag early, before any wallet operations
  const nametag = config.sphereNametag ? validateNametag(config.sphereNametag) : null;

  const { Sphere } = await import('@unicitylabs/sphere-sdk');
  const { createNodeProviders } = await import('@unicitylabs/sphere-sdk/impl/nodejs');

  const providers = createNodeProviders({
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'testnet2' | 'dev',
    dataDir: walletPath,
    tokensDir: join(walletPath, 'tokens'),
  });

  // Create wallet WITHOUT nametag to ensure mnemonic is always persisted first.
  // Nametag registration happens after mnemonic backup so a registration failure
  // can never cause mnemonic loss.
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    // Phase-6 UXF v2 fork: pass network for v2 SphereTokenEngine.
    network: config.sphereNetwork as 'mainnet' | 'testnet' | 'testnet2' | 'dev',
    autoGenerate: true,
  });

  try {
    const identity = sphere.identity;
    if (!identity) {
      throw new Error('Sphere initialized but identity is null — wallet may be corrupt');
    }
    if (!identity.directAddress) {
      throw new Error(
        'Sphere identity has no directAddress — wallet initialization may have failed. ' +
        'Ensure the SDK derives the predicate address during init.',
      );
    }
    const escrowAddress = identity.directAddress;

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

      // Register nametag AFTER mnemonic is safely persisted
      if (nametag) {
        console.log(`Registering nametag @${nametag}...`);
        try {
          await sphere.registerNametag(nametag);
          console.log(`Nametag @${nametag} registered successfully`);
        } catch (regErr) {
          console.error(
            `Failed to register nametag @${nametag}:`,
            regErr instanceof Error ? regErr.message : 'Unknown error',
          );
          console.error('The wallet was created and mnemonic backed up, but nametag registration failed.');
          console.error('Check if the nametag is already taken. Re-run with a different SPHERE_NAMETAG.');
        }
      }

      console.log('\n========================================');
      console.log('  NEW ESCROW WALLET CREATED');
      console.log('========================================\n');
      console.log(`  Address  : ${escrowAddress}`);
      if (sphere.hasNametag()) {
        console.log(`  Nametag  : @${sphere.getNametag()}`);
        const proxyAddr = sphere.getProxyAddress();
        if (proxyAddr) console.log(`  Proxy    : ${proxyAddr}`);
      }
      console.log(`  Network  : ${config.sphereNetwork}`);
      console.log(`  Wallet   : ${walletPath}\n`);
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
      // Existing wallet — register nametag if configured and not yet registered
      if (nametag && !sphere.hasNametag()) {
        console.log(`Registering nametag @${nametag}...`);
        try {
          await sphere.registerNametag(nametag);
          console.log(`Nametag @${nametag} registered successfully`);
        } catch (regErr) {
          console.error(
            `Failed to register nametag @${nametag}:`,
            regErr instanceof Error ? regErr.message : 'Unknown error',
          );
          console.error('The wallet is functional but unreachable via nametag.');
          console.error('Check if the nametag is already taken and choose a different one.');
        }
      }

      // Warn if configured nametag doesn't match the registered one
      if (nametag && sphere.hasNametag() && sphere.getNametag() !== nametag) {
        console.warn(`WARNING: SPHERE_NAMETAG="${nametag}" does not match registered nametag @${sphere.getNametag()}`);
        console.warn('Changing nametag after registration is not supported. Update SPHERE_NAMETAG to match, or use a new wallet.');
      }

      console.log(`Wallet already exists at ${walletPath}`);
      console.log(`  Address  : ${escrowAddress}`);
      if (sphere.hasNametag()) {
        console.log(`  Nametag  : @${sphere.getNametag()}`);
        const proxyAddr = sphere.getProxyAddress();
        if (proxyAddr) console.log(`  Proxy    : ${proxyAddr}`);
      }
      console.log(`  Network  : ${config.sphereNetwork}`);
    }
  } finally {
    try {
      await sphere.destroy();
    } catch (destroyErr) {
      console.error(
        'Warning: cleanup failed:',
        destroyErr instanceof Error ? destroyErr.message : 'Unknown error',
      );
    }
  }
}

main().catch((err) => {
  console.error(
    'Failed to initialize wallet:',
    err instanceof Error ? err.message : 'Unknown error',
  );
  process.exit(1);
});
