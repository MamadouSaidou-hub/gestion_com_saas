# CLAUDE.md — Gestion commerciale SaaS

## Projet
- Quoi : SaaS multi-tenant de gestion commerciale — ventes, stocks, fournisseurs, factures.
- Stack : Next.js 14+ (App Router, Vercel) · Drizzle ORM · Better Auth · Supabase (PostgreSQL).
- Marché : Sénégal / Guinée — mobile-first, réseau lent.

## Standards
- Source de vérité archi/sécu : skill `secure-fullstack-standards`.
- Non-négociables toujours appliqués : authz serveur par opération, isolation tenant
  (RLS plancher + check serveur plafond), audit append-only hash-chainé, secrets hors
  code/DB, paiements idempotents/signés/réconciliés (si mobile money), mobile-first.

## Flotte d'agents
- `architect` — cadre toute feature non-triviale AVANT le code (plan, pas de code).
- `designer` — UI/UX, design system Tailwind/shadcn, maquettes.
- `frontend-next` — Next.js, Tailwind/shadcn, SSR, perf mobile.
- `db-supabase` — schéma, migrations, RLS, index, audit.
- `data-engineer` — imports, pipelines, exports.
- `devops` — CI/CD, Trivy, deploy Vercel, backups.
- `security-reviewer` — audit AVANT merge (obligatoire si authz/paiement/PII/migration).

## Workflow
1. Feature non-triviale : `architect` → implémenteur → `security-reviewer`.
2. Ne jamais merger sans `/ship-check` au vert.
3. `/audit` sur toute PR touchant authz, paiement, PII ou une migration.

## Conventions
- Explications en français, code et commentaires en anglais.
- Code production-ready, typé, dépendances listées.
- Multi-tenant : chaque requête scoping par tenant, jamais de fuite inter-structures.

## Écart de stack et décisions d'architecture (2026-10-16)
- Écart assumé vs skill `secure-fullstack-standards` : pas de FastAPI. Les Route
  Handlers / Server Actions Next.js sont l'API métier ; la discipline hexagonale
  (domain/application/infrastructure) est imposée à l'intérieur de l'app Next.
- D1 — Pas d'offline-first en v1. PWA résiliente : UI optimiste + file de retry sur
  soumission de vente, dégradation propre. Vrai offline → v2 si demandé client.
- D2 — RLS via GUC de session (`app.structure_id`) + rôle DB `app_user` (pas de JWT
  Supabase, Better Auth ne les émet pas). Policies **default-deny** si le GUC est
  vide/absent. Le GUC est reset au checkin de connexion dans le pool (jamais hérité
  d'une requête précédente).
- D3 — Séparation des tâches configurable : rôles cumulables par un même user,
  double-validation imposée seulement sur actions sensibles (annulation/avoir,
  override de prix, rapprochement caisse) avec seuil paramétrable par structure.
- D4 — TVA / mentions légales / numérotation en config par tenant/pays (toggle),
  zéro intégration DGI/dispositif certifié en v1, schéma prêt à l'accueillir.
  Sénégal : facturation électronique déjà obligatoire légalement (loi de finances
  2025) pour les assujettis TVA — à vérifier avec fiscaliste avant engagement client.
  Guinée : dispositif de facture normalisée électronique annoncé (CGI) mais statut
  d'obligation effective non confirmé — à vérifier localement.
- D5 — Notifications OTP/SMS via port abstrait `OtpSender` / `NotificationSender`.
  Défaut : WhatsApp Business en principal, fallback SMS via agrégateur à couverture
  SN/GN réelle (Orange SMS API, Infobip ou Vonage — pas Twilio/Africa's Talking,
  faibles en Afrique de l'Ouest). Valider taux de livraison en sandbox avant de figer.
- D6 — Accès support : rôle audité, time-boxé, données masquées par défaut ; mode
  "break-glass" explicite par session pour voir montants/PII, intégralement
  journalisé dans la chaîne d'audit.
- D7 — Téléphone stocké en E.164 clair, scopé par tenant, indexé. Pas de HMAC (réservé
  à un futur registre inter-structures, hors scope POS).
- D8 — Une devise par structure (XOF Sénégal, GNF Guinée). Montants en entier (unité
  mineure), code devise persisté sur chaque ligne monétaire (pas seulement sur le
  tenant), exposant en config (jamais de float). Pas de multi-devises intra-tenant.
- D9 — Valorisation stock CUMP par défaut, mais paramètre par tenant calculé en
  projection sur le ledger `stock_movements` (source de vérité) — FIFO ajoutable
  plus tard sans migration de données.
- D10 — Chaîne d'audit hash-chaînée **par tenant** (pas de chaîne globale, pour éviter
  la contention et la fuite de métadonnées inter-tenant) + scellé quotidien exporté
  vers un stockage objet WORM au nom du client.
