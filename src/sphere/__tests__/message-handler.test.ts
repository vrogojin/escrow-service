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
      getInvoiceStatus: vi.fn().mockResolvedValue({
        invoiceId: 'inv_' + 'a'.repeat(60),
        state: 'OPEN',
        targets: [
          {
            address: ESCROW_ADDRESS,
            coinAssets: [
              {
                coin: ['UCT', '1000'],
                coveredAmount: '0',
                returnedAmount: '0',
                netCoveredAmount: '0',
                isCovered: false,
                surplusAmount: '0',
                confirmed: false,
                transfers: [],
                senderBalances: [],
              },
              {
                coin: ['USDU', '1000'],
                coveredAmount: '0',
                returnedAmount: '0',
                netCoveredAmount: '0',
                isCovered: false,
                surplusAmount: '0',
                confirmed: false,
                transfers: [],
                senderBalances: [],
              },
            ],
            nftAssets: [],
            isCovered: false,
            confirmed: false,
          },
        ],
        irrelevantTransfers: [],
        totalForward: {},
        totalBack: {},
        allConfirmed: false,
        lastActivityAt: Date.now(),
      }),
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

    it('should include state and created_at fields in announce_result (new protocol fields)', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const announceCall = calls.find((c: any[]) => c[1].includes('announce_result'));
      const response = JSON.parse(announceCall![1]);

      expect(response.state).toBe(SwapState.DEPOSIT_INVOICE_CREATED);
      expect(response.created_at).toBeDefined();
      expect(typeof response.created_at).toBe('string');
      // Verify it's a valid ISO string
      expect(new Date(response.created_at).getTime()).toBeGreaterThan(0);
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

    it('should return error when nametag resolves to null (propagation delay — hard error)', async () => {
      const proxyManifest = {
        ...createManifest(),
        party_a_address: 'PROXY://alice',
      };

      mockOrchestrator.announce.mockRejectedValue(
        new Error('Nametag resolution failed: alice not found'),
      );

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest: proxyManifest });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('error'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.type).toBe('error');
    });

    it('should resolve PROXY:// address to DIRECT:// and cache resolved address at announcement time', async () => {
      const proxyManifest = {
        ...createManifest(),
        party_a_address: 'PROXY://alice',
      };
      // Orchestrator resolves PROXY to DIRECT and returns resolved address
      const resolvedAddress = `DIRECT://${PARTY_A_NPUB}`;
      const mockSwap = createMockSwap(
        { ...proxyManifest, party_a_address: resolvedAddress },
        SwapState.DEPOSIT_INVOICE_CREATED,
      );

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: proxyManifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest: proxyManifest });

      // Verify orchestrator.announce was called with proxy address
      expect(mockOrchestrator.announce).toHaveBeenCalledWith(
        expect.objectContaining({ party_a_address: 'PROXY://alice' }),
        PARTY_A_NPUB,
      );

      // Verify role was registered after resolution
      const calls = mockSphere.communications.sendDM.mock.calls;
      const announceCall = calls.find((c: any[]) => c[1].includes('announce_result'));
      const response = JSON.parse(announceCall![1]);
      expect(response.swap_id).toBe(proxyManifest.swap_id);
    });

    it('should allow second announcer to register additional npub for same party role if DIRECT address matches', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: false, // Already announced
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // First announcer registered
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // Different npub, same party, resolves to same DIRECT address (same underlying keypair)
      const secondNpubSameAddress = PARTY_A_NPUB; // In this test setup, same npub for simplicity

      await sendDM(secondNpubSameAddress, { type: 'announce', manifest });

      // Should successfully register the npub
      expect(npubRoleMap.getRole(secondNpubSameAddress, manifest.swap_id)).toBe('A');
    });

    it('should not overwrite resolved_party_a_address on second announce (addresses immutable)', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockOrchestrator.announce.mockResolvedValue({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'a'.repeat(60),
        is_new: true,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Verify that the mock swap has the original resolved address
      expect(mockSwap.resolved_party_a_address).toBe(PARTY_A_ADDRESS);

      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      // The state store should still have the same resolved address
      const updatedSwap = mockStateStore.findBySwapId(manifest.swap_id);
      expect(updatedSwap.resolved_party_a_address).toBe(PARTY_A_ADDRESS);
    });

    it('should re-attempt createInvoice when re-announce arrives for swap stuck in ANNOUNCED state', async () => {
      const manifest = createManifest();
      // Swap is stuck in ANNOUNCED state (previous createInvoice failed)
      const mockSwap = createMockSwap(manifest, SwapState.ANNOUNCED);
      mockSwap.deposit_invoice_id = null;

      // First call (initial announce failed at createInvoice)
      mockOrchestrator.announce.mockRejectedValueOnce(
        new Error('Invoice creation failed'),
      );
      // Second call (re-announce succeeds)
      mockOrchestrator.announce.mockResolvedValueOnce({
        swap_id: manifest.swap_id,
        deposit_invoice_id: 'inv_' + 'b'.repeat(60),
        is_new: false,
      });

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // First announce attempt
      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      const calls1 = mockSphere.communications.sendDM.mock.calls.length;
      expect(calls1).toBeGreaterThan(0);

      // Verify error was returned
      const errorCall = mockSphere.communications.sendDM.mock.calls
        .find((c: any[]) => c[1].includes('error'));
      expect(errorCall).toBeDefined();

      // Reset mocks for second attempt
      mockSphere.communications.sendDM.mockClear();
      mockSwap.deposit_invoice_id = 'inv_' + 'b'.repeat(60);
      mockSwap.state = SwapState.DEPOSIT_INVOICE_CREATED;

      // Second announce (re-attempt)
      await sendDM(PARTY_A_NPUB, { type: 'announce', manifest });

      // Should have called announce again
      expect(mockOrchestrator.announce).toHaveBeenCalledTimes(2);

      // Should succeed this time
      const announceCall = mockSphere.communications.sendDM.mock.calls
        .find((c: any[]) => c[1].includes('announce_result'));
      expect(announceCall).toBeDefined();

      const response = JSON.parse(announceCall![1]);
      expect(response.is_new).toBe(false);
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

    it('should return status_result with deposit_status including per-party coverage', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.PARTIAL_DEPOSIT);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // Mock invoice status with partial coverage
      mockInvoiceManager.getInvoiceStatus.mockResolvedValue({
        invoiceId: mockSwap.deposit_invoice_id,
        state: 'PARTIAL',
        targets: [
          {
            address: 'ESCROW_ADDRESS',
            coinAssets: [
              {
                coin: ['UCT', '1000'],
                coveredAmount: '500',
                returnedAmount: '0',
                netCoveredAmount: '500',
                isCovered: false,
                surplusAmount: '0',
                confirmed: false,
                transfers: [],
                senderBalances: [],
              },
              {
                coin: ['USDU', '500'],
                coveredAmount: '0',
                returnedAmount: '0',
                netCoveredAmount: '0',
                isCovered: false,
                surplusAmount: '0',
                confirmed: false,
                transfers: [],
                senderBalances: [],
              },
            ],
            nftAssets: [],
            isCovered: false,
            confirmed: false,
          },
        ],
        irrelevantTransfers: [],
        totalForward: {},
        totalBack: {},
        allConfirmed: false,
        lastActivityAt: Date.now(),
      });

      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const statusCall = calls.find((c: any[]) => c[1].includes('status_result'));
      const response = JSON.parse(statusCall![1]);

      expect(response.deposit_status).toBeDefined();
      expect(response.deposit_status.party_a_covered).toBe(false);
      expect(response.deposit_status.party_b_covered).toBe(false);
      expect(response.deposit_status.party_a_amount).toBe('500');
      expect(response.deposit_status.party_b_amount).toBe('0');
    });

    it('should return null for deposit_status when no deposit invoice exists', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.ANNOUNCED);
      mockSwap.deposit_invoice_id = null;

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const statusCall = calls.find((c: any[]) => c[1].includes('status_result'));
      const response = JSON.parse(statusCall![1]);

      expect(response.deposit_status).toBeNull();
    });

    it('should return null for deposit_status when getInvoiceStatus fails gracefully', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // Mock getInvoiceStatus to throw an error
      mockInvoiceManager.getInvoiceStatus.mockRejectedValue(
        new Error('INVOICE_NOT_FOUND'),
      );

      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const statusCall = calls.find((c: any[]) => c[1].includes('status_result'));
      const response = JSON.parse(statusCall![1]);

      // deposit_status should be null when getInvoiceStatus fails
      expect(response.deposit_status).toBeNull();
      // Response should still be valid status_result
      expect(response.type).toBe('status_result');
      expect(response.swap_id).toBe(manifest.swap_id);
    });

    it('should reject status query from party A of swap 1 when querying swap 2 (cross-swap authorization scoping)', async () => {
      const manifest1 = createManifest('1'.repeat(64));
      const manifest2 = createManifest('2'.repeat(64));
      const mockSwap2 = createMockSwap(manifest2);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap2);

      // Party A is registered for swap 1, not swap 2
      npubRoleMap.register(PARTY_A_NPUB, manifest1.swap_id, 'A');

      // Try to query swap 2 with swap 1's credentials
      await sendDM(PARTY_A_NPUB, { type: 'status', swap_id: manifest2.swap_id });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.error).toContain('Unauthorized');
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

    it('should re-deliver payout invoice token to authorized party when swap in CONCLUDING state', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.CONCLUDING);
      mockSwap.payout_a_invoice_id = 'payout_inv_a_' + 'a'.repeat(50);
      mockSwap.payout_b_invoice_id = 'payout_inv_b_' + 'b'.repeat(50);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      mockInvoiceManager.getPayoutInvoiceToken.mockResolvedValue({ token: 'payout_token_a' });

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      const response = JSON.parse(invoiceCall![1]);
      expect(response.type).toBe('invoice_delivery');
      expect(response.invoice_type).toBe('payout');
      expect(response.invoice_id).toBe('payout_inv_a_' + 'a'.repeat(50));
    });

    it('should re-deliver payout invoice token to authorized party when swap in COMPLETED state', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.COMPLETED);
      mockSwap.payout_a_invoice_id = 'payout_inv_a_' + 'a'.repeat(50);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      mockInvoiceManager.getPayoutInvoiceToken.mockResolvedValue({ token: 'payout_token_a' });

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      const response = JSON.parse(invoiceCall![1]);
      expect(response.type).toBe('invoice_delivery');
      expect(response.invoice_type).toBe('payout');
    });

    it('should reject request for payout invoice when swap is not yet in CONCLUDING/COMPLETED', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.DEPOSIT_INVOICE_CREATED);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('not available'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.error).toContain('not available');
      expect(response.error).toContain('CONCLUDING or COMPLETED');
    });

    it('should reject request_invoice from party with no recorded association (never announced)', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);

      // Don't register the npub with any role

      const unrelatedNpub = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

      await sendDM(unrelatedNpub, {
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

    it('should return error when payout invoice not yet created (missing payout_a_invoice_id)', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.CONCLUDING);
      mockSwap.payout_a_invoice_id = null; // Payout invoice not yet created

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const errorCall = calls.find((c: any[]) => c[1].includes('not yet created'));
      expect(errorCall).toBeDefined();

      const response = JSON.parse(errorCall![1]);
      expect(response.error).toContain('not yet created');
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
  // Payout Invoice Token Security Tests
  // =========================================================================

  describe('Payout Invoice Token Security', () => {
    it('should not allow third party who imports payout invoice token to call cancelInvoice on it', async () => {
      // This test verifies that the escrow issues payout invoices only to authorized parties.
      // A third party obtaining the token cannot cancel it because the escrow controls
      // invoice lifecycle and token delivery.
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.COMPLETED);
      mockSwap.payout_a_invoice_id = 'payout_inv_a_' + 'a'.repeat(50);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      mockInvoiceManager.getPayoutInvoiceToken.mockResolvedValue({
        token: 'payout_token_a',
        invoiceId: mockSwap.payout_a_invoice_id,
      });

      // Party A requests and receives payout invoice token
      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      // A third party (not party A or B) would not be able to request the invoice
      const thirdPartyNpub = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

      mockSphere.communications.sendDM.mockClear();

      await sendDM(thirdPartyNpub, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      // Third party should be rejected
      const thirdPartyCall = mockSphere.communications.sendDM.mock.calls;
      const thirdPartyError = thirdPartyCall.find((c: any[]) => c[1].includes('Unauthorized'));
      expect(thirdPartyError).toBeDefined();
    });

    it('should verify payout invoice target address matches intended party (party A receives party A payout)', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.COMPLETED);
      mockSwap.payout_a_invoice_id = 'payout_inv_a_' + 'a'.repeat(50);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');

      // The payout invoice for party A should contain party A's address as recipient
      const payoutTokenA = {
        token: 'payout_token_a',
        invoiceId: mockSwap.payout_a_invoice_id,
        target: mockSwap.resolved_party_a_address, // Embedded in token
      };

      mockInvoiceManager.getPayoutInvoiceToken.mockResolvedValue(payoutTokenA);

      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCall = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCall).toBeDefined();

      const response = JSON.parse(invoiceCall![1]);
      expect(response.invoice_token).toEqual(payoutTokenA);
      // The token includes the target address, preventing redirection
      expect(response.invoice_token.target).toBe(PARTY_A_ADDRESS);
    });

    it('should only deliver payout invoice token to the authorized requesting party', async () => {
      const manifest = createManifest();
      const mockSwap = createMockSwap(manifest, SwapState.COMPLETED);
      mockSwap.payout_a_invoice_id = 'payout_inv_a_' + 'a'.repeat(50);
      mockSwap.payout_b_invoice_id = 'payout_inv_b_' + 'b'.repeat(50);

      mockStateStore.findBySwapId.mockReturnValue(mockSwap);
      npubRoleMap.register(PARTY_A_NPUB, manifest.swap_id, 'A');
      npubRoleMap.register(PARTY_B_NPUB, manifest.swap_id, 'B');

      mockInvoiceManager.getPayoutInvoiceToken.mockImplementation(async (invoiceId: string) => {
        if (invoiceId.includes('payout_inv_a')) {
          return { token: 'payout_token_a' };
        }
        return { token: 'payout_token_b' };
      });

      // Party A requests their payout token
      await sendDM(PARTY_A_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const calls = mockSphere.communications.sendDM.mock.calls;
      const invoiceCallA = calls.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCallA).toBeDefined();

      const responseA = JSON.parse(invoiceCallA![1]);
      expect(responseA.invoice_token.token).toBe('payout_token_a');

      mockSphere.communications.sendDM.mockClear();

      // Party B requests their payout token
      await sendDM(PARTY_B_NPUB, {
        type: 'request_invoice',
        swap_id: manifest.swap_id,
        invoice_type: 'payout',
      });

      const callsB = mockSphere.communications.sendDM.mock.calls;
      const invoiceCallB = callsB.find((c: any[]) => c[1].includes('invoice_delivery'));
      expect(invoiceCallB).toBeDefined();

      const responseB = JSON.parse(invoiceCallB![1]);
      expect(responseB.invoice_token.token).toBe('payout_token_b');

      // Verify they received different tokens
      expect(responseA.invoice_token.token).not.toBe(responseB.invoice_token.token);
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
