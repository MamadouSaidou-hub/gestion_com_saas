// DESIGN MOCKUP DATA -- sample team members. `memberships` IS a real table
// (see src/db/schema/tenancy.ts), but this screen doesn't query it yet --
// it's sample data shaped like a real membership row (role straight from
// `MembershipRole`) so wiring the real query later is a drop-in swap.
import type { MembershipRole } from "@/modules/tenancy/types";

export interface MockTeamMember {
  id: string;
  name: string;
  phone: string; // E.164 (D7)
  role: MembershipRole;
  joinedOn: string; // ISO date
}

export const MOCK_TEAM: MockTeamMember[] = [
  { id: "u1", name: "Awa Diallo", phone: "+221771112233", role: "owner", joinedOn: "2024-03-10" },
  { id: "u2", name: "Mamadou Sarr", phone: "+221772223344", role: "manager", joinedOn: "2024-05-02" },
  { id: "u3", name: "Khady Fall", phone: "+221773334455", role: "cashier", joinedOn: "2025-01-14" },
  { id: "u4", name: "Alpha Touré", phone: "+224623445566", role: "cashier", joinedOn: "2025-06-20" },
  { id: "u5", name: "Ousmane Bâ", phone: "+221774445566", role: "stock_keeper", joinedOn: "2025-02-11" },
  { id: "u6", name: "Mariama Camara", phone: "+224624556677", role: "accountant", joinedOn: "2024-11-30" },
  { id: "u7", name: "Lamine Gueye", phone: "+221775556677", role: "auditor", joinedOn: "2025-08-01" },
];
