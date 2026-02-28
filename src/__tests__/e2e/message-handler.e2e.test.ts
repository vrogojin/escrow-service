import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMessageHandler, type MessageHandler } from '../../sphere/message-handler.js';
import {
  createMockSphereWithCommunications,
  createMockWalletManager,
  createTestManifest,
} from '../helpers/mock-sphere.js';
import { createIntegrationContext, type TestContext } from '../helpers/in-memory-store.js';
import { ManifestValidationError, SwapLimitError } from '../../core/swap-manager.js';
import type { Sphere } from '@unicitylabs/sphere-sdk';

describe('Message Handler E2E', () => {
  let mockSphere: ReturnType<typeof createMockSphereWithCommunications>;
  let walletManager: ReturnType<typeof createMockWalletManager>;
  let ctx: TestContext;
  let handler: MessageHandler;

  beforeEach(() => {
    mockSphere = createMockSphereWithCommunications();
    walletManager = createMockWalletManager();
    ctx = createIntegrationContext();

    handler = createMessageHandler({
      sphere: mockSphere.sphere as unknown as Sphere,
      swapManager: ctx.swapManager,
      depositRepo: ctx.depositRepo as any,
      txRepo: ctx.txRepo as any,
      walletManager,
    });
    handler.start();
  });

  afterEach(async () => {
    await handler.stop();
  });

  function parseSentReply(index = 0): Record<string, unknown> {
    expect(mockSphere.sentDMs.length).toBeGreaterThan(index);
    return JSON.parse(mockSphere.sentDMs[index].content);
  }

  const senderPubkey = 'aabb'.repeat(16);

  // =========================================================================
  // announce
  // =========================================================================
  describe('announce', () => {
    it('should announce a new swap and return announce_result', async () => {
      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('announce_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
      expect(reply.state).toBe('ANNOUNCED');
      expect(reply.is_new).toBe(true);
      expect(reply.created_at).toBeDefined();
    });

    it('should return is_new=false for duplicate manifest', async () => {
      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('announce_result');
      expect(reply.is_new).toBe(false);
    });

    it('should return error when manifest is missing', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce' }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Request body must contain a "manifest" object');
    });

    it('should return validation error for invalid manifest fields', async () => {
      const dm = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'announce', manifest: { invalid: true } }),
      );
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Manifest validation failed');
      expect(reply.details).toBeDefined();
      expect(Array.isArray(reply.details)).toBe(true);
    });

    it('should strip unknown fields from manifest', async () => {
      const manifest = createTestManifest();
      const manifestWithExtra = { ...manifest, __proto_pollute: true, extra_field: 'evil' };
      const spy = vi.spyOn(ctx.swapManager, 'announceSwap');
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest: manifestWithExtra }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('announce_result');
      expect(reply.swap_id).toBe(manifest.swap_id);

      // Verify stripped fields did NOT reach swapManager
      const calledWith = spy.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('extra_field');
      expect(calledWith).not.toHaveProperty('__proto_pollute');
      spy.mockRestore();
    });

    it('should reject manifest that is an array', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest: [1, 2, 3] }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Request body must contain a "manifest" object');
    });
  });

  // =========================================================================
  // status
  // =========================================================================
  describe('status', () => {
    it('should return status_result for a valid swap', async () => {
      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: manifest.swap_id }),
      );
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('status_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
      expect(reply.state).toBe('ANNOUNCED');
      expect(reply.manifest).toBeDefined();
      expect(reply.deposits).toEqual([]);
      expect(reply.transactions).toEqual([]);
    });

    it('should return error for invalid swap_id', async () => {
      const dm = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: 'not-valid' }),
      );
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Invalid swap_id: must be exactly 64 lowercase hex characters');
    });

    it('should return error when swap not found', async () => {
      const dm = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: 'a'.repeat(64) }),
      );
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Swap not found');
    });

    it('should include deposits and transactions', async () => {
      const manifest = createTestManifest();
      // Announce
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      // Add a deposit directly to the repo
      await ctx.depositRepo.create({
        swap_id: manifest.swap_id,
        transaction_id: 'tx_123',
        sender: manifest.party_a_address,
        amount: '1000',
        coin_id: 'USD',
        memo: manifest.swap_id,
        matched_party: 'A',
      });

      // Add a transaction directly to the repo
      await ctx.txRepo.create({
        swap_id: manifest.swap_id,
        type: 'CROSS_PAYMENT',
        direction: 'OUTGOING',
        sender: 'DIRECT://escrow_pubkey_hex',
        recipient: manifest.party_b_address,
        amount: '1000',
        coin_id: 'USD',
        status: 'SENT',
      });

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: manifest.swap_id }),
      );
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('status_result');
      expect((reply.deposits as any[]).length).toBe(1);
      expect((reply.deposits as any[])[0].transaction_id).toBe('tx_123');
      expect((reply.transactions as any[]).length).toBe(1);
      expect((reply.transactions as any[])[0].type).toBe('CROSS_PAYMENT');
      expect((reply.transactions as any[])[0].recipient).toBe(manifest.party_b_address);
      expect((reply.transactions as any[])[0].amount).toBe('1000');
    });

    it('should normalize uppercase swap_id to lowercase for lookup', async () => {
      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: manifest.swap_id.toUpperCase() }),
      );
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('status_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
    });
  });

  // =========================================================================
  // deposit_instructions
  // =========================================================================
  describe('deposit_instructions', () => {
    it('should return deposit instructions for a valid swap', async () => {
      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'deposit_instructions', swap_id: manifest.swap_id }),
      );
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('deposit_instructions_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
      expect(reply.escrow_address).toBe('DIRECT://escrow_pubkey_hex');
      expect(reply.memo).toBe(manifest.swap_id);
      expect((reply.party_a as any).address).toBe(manifest.party_a_address);
      expect((reply.party_a as any).currency).toBe(manifest.party_a_currency_to_change);
      expect((reply.party_a as any).amount).toBe(manifest.party_a_value_to_change);
      expect((reply.party_b as any).address).toBe(manifest.party_b_address);
      expect((reply.party_b as any).currency).toBe(manifest.party_b_currency_to_change);
      expect((reply.party_b as any).amount).toBe(manifest.party_b_value_to_change);
    });

    it('should return error when swap not found', async () => {
      const dm = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'deposit_instructions', swap_id: 'b'.repeat(64) }),
      );
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Swap not found');
    });

    it('should return error for invalid swap_id', async () => {
      const dm = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'deposit_instructions', swap_id: 'xyz' }),
      );
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Invalid swap_id: must be exactly 64 lowercase hex characters');
    });

    it('should normalize uppercase swap_id to lowercase for lookup', async () => {
      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'deposit_instructions', swap_id: manifest.swap_id.toUpperCase() }),
      );
      await mockSphere.simulateDM(dm2);

      const reply = parseSentReply();
      expect(reply.type).toBe('deposit_instructions_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
    });
  });

  // =========================================================================
  // error handling
  // =========================================================================
  describe('error handling', () => {
    it('should reply with error for invalid JSON', async () => {
      const dm = mockSphere.createDM(senderPubkey, 'not json {{');
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Invalid JSON');
    });

    it('should reply with error for missing type field', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ swap_id: 'abc' }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Missing or invalid "type" field');
    });

    it('should reply with error for non-string type field', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 123 }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Missing or invalid "type" field');
    });

    it('should reply with error for message exceeding size limit', async () => {
      const largeContent = JSON.stringify({ type: 'announce', manifest: { padding: 'x'.repeat(70000) } });
      const dm = mockSphere.createDM(senderPubkey, largeContent);
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Message too large');
    });

    it('should reply with error for unknown message type', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'foo_bar' }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Unknown message type: foo_bar');
    });

    it('should reply with error for non-object message (array)', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify([1, 2, 3]));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Message must be a JSON object');
    });

    it('should reply with error for non-object message (string)', async () => {
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify('hello'));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Message must be a JSON object');
    });

    it('should return SwapLimitError as error reply', async () => {
      const spy = vi.spyOn(ctx.swapManager, 'announceSwap').mockRejectedValue(
        new SwapLimitError('Maximum pending swaps limit reached (10000)'),
      );

      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Maximum pending swaps limit reached (10000)');
      spy.mockRestore();
    });

    it('should return PG 23505 duplicate error as "Swap already exists"', async () => {
      const spy = vi.spyOn(ctx.swapManager, 'announceSwap').mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Swap already exists');
      spy.mockRestore();
    });

    it('should return "Internal server error" for unknown exceptions', async () => {
      const spy = vi.spyOn(ctx.swapManager, 'announceSwap').mockRejectedValue(
        new TypeError('something unexpected'),
      );

      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('error');
      expect(reply.error).toBe('Internal server error');
      spy.mockRestore();
    });

    it('should survive sendDM failure and continue processing', async () => {
      // Make sendDM fail once
      mockSphere.sendDM.mockRejectedValueOnce(new Error('Nostr relay down'));

      const manifest = createTestManifest();
      const dm1 = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm1);

      // sendDM was called but failed — no crash
      expect(mockSphere.sendDM).toHaveBeenCalledTimes(1);

      // Handler still works for subsequent messages
      mockSphere.sentDMs.length = 0;
      const dm2 = mockSphere.createDM(
        senderPubkey,
        JSON.stringify({ type: 'status', swap_id: manifest.swap_id }),
      );
      await mockSphere.simulateDM(dm2);

      // The swap was created despite the reply failure, so status should find it
      const reply = parseSentReply();
      expect(reply.type).toBe('status_result');
      expect(reply.swap_id).toBe(manifest.swap_id);
    });
  });

  // =========================================================================
  // lifecycle
  // =========================================================================
  describe('lifecycle', () => {
    it('should not process messages after stop()', async () => {
      await handler.stop();

      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      expect(mockSphere.sentDMs.length).toBe(0);
    });

    it('should handle idempotent start()', () => {
      // start() was already called in beforeEach; calling again should not throw
      handler.start();
      expect(mockSphere.onDirectMessage).toHaveBeenCalledTimes(1);
    });

    it('should handle idempotent stop()', async () => {
      await handler.stop();
      await handler.stop(); // should not throw
    });

    it('should be restartable after stop()', async () => {
      await handler.stop();
      handler.start();

      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      await mockSphere.simulateDM(dm);

      const reply = parseSentReply();
      expect(reply.type).toBe('announce_result');
    });

    it('should drain in-flight handlers on stop()', async () => {
      const manifest = createTestManifest();
      const dm = mockSphere.createDM(senderPubkey, JSON.stringify({ type: 'announce', manifest }));
      // Simulate DM without awaiting — handler is in-flight
      mockSphere.simulateDM(dm);

      // stop() should wait for in-flight to complete
      await handler.stop();

      // By the time stop() resolves, the reply should have been sent
      expect(mockSphere.sentDMs.length).toBeGreaterThan(0);
      const reply = parseSentReply();
      expect(reply.type).toBe('announce_result');
    });
  });
});
