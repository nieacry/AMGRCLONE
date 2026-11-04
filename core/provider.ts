// Contract for the next milestones. No placeholder files are emulated in v0.1.
export type ItemIdentity = { accountId: string; itemId: string; revision: string };
export type Availability = 'online' | 'local';
export type ActualState = 'placeholder' | 'hydrating' | 'cached' | 'pinned' | 'dirty' | 'uploading' | 'conflict' | 'error';
export interface NativeFileProvider {
  registerDomain(accountId: string): Promise<{ managedRoot: string }>;
  setAvailability(item: ItemIdentity, desired: Availability): Promise<void>;
  getState(item: ItemIdentity): Promise<ActualState>;
  // Dehydrate only if the current revision is uploaded and no open/dirty ranges exist.
  evictCleanItem(item: ItemIdentity): Promise<void>;
  unregisterDomain(accountId: string, preserveLocalChanges: true): Promise<void>;
}
