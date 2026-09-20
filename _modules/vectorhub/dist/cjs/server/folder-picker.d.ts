export interface PickFolderResult {
    /** Selected absolute path, or null when the user cancelled. */
    path: string | null;
}
export interface PickFolderError extends Error {
    status: number;
}
/** Opens the native folder picker. Resolves with `{ path: null }` on cancel. */
export declare function pickFolder(): Promise<PickFolderResult>;
