export interface AuthIdentity {
  /** The unique subject identifier (e.g. JWT 'sub') */
  subject: string;
  /** Optional additional claims/attributes */
  claims?: Record<string, unknown>;
}
