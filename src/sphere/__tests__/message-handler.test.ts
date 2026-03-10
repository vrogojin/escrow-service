import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DirectMessage } from '@unicitylabs/sphere-sdk';
import { createMessageHandler } from '../message-handler.js';
import type { MessageHandlerDeps, NpubRoleMap } from '../message-handler.js';
import type { SwapOrchestrator } from '../orchestrator-interfaces.js';
import type { InvoiceManager } from '../orchestrator-interfaces.js';
import type { SwapStateStore, SwapRecord } from '../../core/types.js';
import { SwapState } from '../../core/state-machine.js';

const ESCROW_ADDRESS = 'DIRECT://escrow';
const PARTY_A_NPUB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARTY_B_NPUB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PARTY_A_ADDRESS = `DIRECT://${PARTY_A_NPUB}`;
const PARTY_B_ADDRESS = `DIRECT://${PARTY_B_NPUB}`;

// Mock NpubRoleMap implementation
class MockNpubRoleMap implements NpubRoleMap {
  private map = new Map<string, Map<string, 'A' | 'B'>>();

  register(npub: string, swapId: string, party: 'A' | 'B'): void {
    if (!this.map.has(npub)) {
      this.map.set(npub, new Map());
    }
    this.map.get(npub)!.set(swapId, party);
  }

  getRole(npub: string, swapId: string): 'A' | 'B' | null {
    return this.map.get(npub)?.get(swapId) ?? null;
  }

  getSwapIds(npub: string): string[] {
    const swapMap = this.map.get(npub);
    return swapMap ? Array.from(swapMap.keys()) : [];
  }
}

describe('Message Handler', () => {
  let mockSphere: any;
  let mockOrchestrator: any;
  let mockStateStore: any;
  let mockInvoiceManager: any;
  let npubRoleMap: MockNpubRoleMap;
  let handler: ReturnType<typeof createMessageHandler>;
  let dmCallbacks: Map<string, (dm: DirectMessage) => void>;

  beforeEach(() => {
    dmCallbacks = new Map();

    // Mock Sphere communications
    mockSphere = {
      communications: {
        sendDM: vi.fn().mockResolvedValue(undefined),
        onDirectMessage: vi.fn((callback: (dm: DirectMessage) => void) => {
          dmCallbacks.set('onDirectMessage', callback);
          return () => {
            dmCallbacks.delete('onDirectMessage');
          };
        }),
      },
    };

    // Mock orchestrator
    mockOrchestrator = {
      announce: vi.fn().mockResolvedValue({
        swap_id: 'a'.repeat(64),
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      }),
    };

    // Mock state store
    mockStateStore = {
      findBySwapId: vi.fn(),
      create: vi.fn(),
    };

    // Mock invoice manager
    mockInvoiceManager = {
      getDepositInvoiceToken: vi.fn().mockResolvedValue({ token: 'deposit_token' }),
      getPayoutInvoiceToken: vi.fn().mockResolvedValue({ token: 'payout_token' }),
    };

    npubRoleMap = new MockNpubRoleMap();

    const deps: MessageHandlerDeps = {
      sphere: mockSphere,
      orchestrator: mockOrchestrator,
      stateStore: mockStateStore,
      invoiceManager: mockInvoiceManager,
      npubRoleMap,
    };

    handler = createMessageHandler(deps);
    handler.start();
  });

  // Helper to simulate an incoming DM
  async function sendDM(senderPubkey: string, content: Record<string, unknown>) {
    const dm: DirectMessage = {
      id: 'dm_' + Math.random().toString(36).substr(2, 9),
      senderPubkey,
      recipientPubkey: 'escrow_npub',
      content: JSON.stringify(content),
      timestamp: Date.now(),
    };

    const callback = dmCallbacks.get('onDirectMessage');
    if (callback) {
      await callback(dm);
    }
  }

  // Helper to create a basic manifest
  function createManifest(swapId: string = 'a'.repeat(64)) {
    return {
      swap_id: swapId,
      party_a_address: PARTY_A_ADDRESS,
      party_b_address: PARTY_B_ADDRESS,
      party_a_currency_to_change: 'UCT',
      party_a_value_to_change: '1000',
      party_b_currency_to_change: 'USDU',
      party_b_value_to_change: '500',
      timeout: 600,
    };
  }

  // Helper to create a mock swap record
  function createMockSwap(manifest: ReturnType<typeof createManifest>, state: SwapState = SwapState.ANNOUNCED): SwapRecord {
    return {
      swap_id: manifest.swap_id,
      manifest,
      state,
      deposit_invoice_id: 'inv_' + 'a'.repeat(60),
      payout_a_invoice_id: null,
      payout_b_invoice_id: null,
      resolved_party_a_address: PARTY_A_ADDRESS,
      resolved_party_b_address: PARTY_B_ADDRESS,
      first_deposit_at: null,
      timeout_at: null,
      created_at: Date.now(),
      completed_at: null,
      error_message: null,
      version: 1,
    };
  }

  // =========================================================================
  // announce Message Tests
  // =========================================================================

  describe('announce Message', () => {
    it('should create swap and return announce_result with deposit_invoice_id', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      expect(mockOrchestrator.announce).toHaveBeenCalled();
      expect(mockSphere.communications.sendDM).toHaveBeenCalledWith(
        PARTY_A_NPUB,
        expect.stringContaining('announce_result'),
      );

      const calls = mockSphere.communications.sendDM.mock.calls;
      const announceCall = calls.find((c: any[]) => c[1].includes('announce_result'));
      expect(announceCall).toBeDefined();

      const response = JSON.parse(announceCall[1]);
      expect(response.type).toBe('announce_result');
      expect(response.swap_id).toBe(manifest.swap_id);
      expect(response.deposit_invoice_id).toBe('inv_' + 'a'.repeat(60));
      expect(response.is_new).toBe(true);
    });

    it('should record sender npub association with party role', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      const registerSpy = vi.spyOn(npubRoleMap, 'register');

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      expect(registerSpy).toHaveBeenCalledWith(PARTY_A_NPUB, manifest.swap_id, 'A');
    });

    it('should return existing swap (is_new: false) for duplicate announcement', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: false,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const announceCall = calls.find((c: any[]) => c[1].includes('announce_result'));
      const response = JSON.parse(announceCall![1]);

      expect(response.is_new).toBe(false);
    });

    it('should return error when manifest validation fails', async () => {
      const invalidManifest = {
        swap_id: 'invalid',
        party_a_address: PARTY_A_ADDRESS,
        // Missing required fields
      };

      mockOrchestrator.announce.mockRejectedValue(
        new Error('Manifest validation failed'),
      );

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest: invalidManifest });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('error'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.type).toBe('error');
    });
  });

  // =========================================================================
  // status Message Tests
  // =========================================================================

  describe('status Message', () => {
    it('should return status for authorized party', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const statusCall = calls.find((c: any[]) => c[1].includes('status_result'));
      expect(statusCall).toBeDefined();

      const response = JSON.parse(statusCall![1]);
      expect(response.type).toBe('status_result');
      expect(response.swap_id).toBe(manifest.swap_id);
      expect(response.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
    });

    it('should reject status from unauthorized npub', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Don't register the npub with any role

      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.error).toContain('Unauthorized');
    });

    it('should reject status from attacker with npub in role map but wrong DIRECT address', async () => {
      const manifest = createManifest();
      const attackerManifest = {
        ...manifest,
        party_a_address: 'DIRECT://attacker_address',
      };
      const mockSwap = createMockSwap(attackerManifest);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Attacker announced first and registered themselves as party A
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // But the actual party A (with different npub) tries to query status
      const realPartyANpub = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

      await sendDM(realPartyANpub, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(errorCall).toBeDefined();
    });
  });

  // =========================================================================
  // request_invoice Message Tests
  // =========================================================================

  describe('request_invoice Message', () => {
    it('should re-deliver deposit invoice token to authorized party', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      mockInvoiceManager.getDepositInvoiceToken.mockResolvedValue({ token: 'deposit_token_data' });

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'deposit',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      const response = JSON.parse(invoiceCall![1]);
      expect(response.type).toBe('invoice_delivery');
      expect(response.invoice_type).toBe('deposit');
      expect(response.invoice_token).toBeDefined();
    });

    it('should reject request from unauthorized party', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Don't register the npub

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'deposit',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.error).toContain('Unauthorized');
    });

    it('should reject request_invoice from attacker who announced first (DIRECT address mismatch)', async () => {
      const manifest = createManifest();
      const attackerManifest = {
        ...manifest,
        party_a_address: 'DIRECT://attacker_address',
      };
      const mockSwap = createMockSwap(attackerManifest);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Attacker announced first
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // Real party A tries to request invoice but their address doesn't match
      const realPartyANpub = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

      await sendDM(realPartyANpub, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'deposit',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(errorCall).toBeDefined();
    });
  });

  // =========================================================================
  // Legacy Compatibility Tests
  // =========================================================================

  describe('Legacy Compatibility', () => {
    it('should handle deposit_instructions as alias for request_invoice', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      mockInvoiceManager.getDepositInvoiceToken.mockResolvedValue({ token: 'deposit_token_data' });

      await sendDM(PARTY_A_NPUB, {
        type: 'deposit_instructions',
        swap_id: manifest.swap_id,
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      const response = JSON.parse(invoiceCall![1]);
      expect(response.type).toBe('invoice_delivery');
      expect(response.invoice_type).toBe('deposit');
    });
  });

  // =========================================================================
  // Error Handling Tests
  // =========================================================================

  describe('Error Handling', () => {
    it('should return error response for malformed messages', async () => {
      // Send invalid JSON
      const dm: DirectMessage = {
        id: 'dm_invalid',
        senderPubkey: PARTY_A_NPUB,
        recipientPubkey: 'escrow_npub',
        content: '{invalid json}',
        timestamp: Date.now(),
      };

      const callback = dmCallbacks.get('onDirectMessage');
      if (callback) {
        await callback(dm);
      }

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Invalid JSON'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.type).toBe('error');
      expect(response.error).toContain('Invalid JSON');
    });

    it('should return error for missing type field', async () => {
      await sendDM(PARTY_A_NPUB, { manifest: {} });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('type'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.type).toBe('error');
    });

    it('should return error for unknown message type', async () => {
      await sendDM(PARTY_A_NPUB, { type: 'unknown_message_type' });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unknown message type'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.type).toBe('error');
    });
  });
});
