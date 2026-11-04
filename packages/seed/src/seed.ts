/**
 * Development seed.
 *
 * Creates the minimum a person needs to sign in and start working: an admin
 * user, the operator-editable settings with their defaults, and a starting
 * taxonomy vocabulary.
 *
 * Two rules from §37 shape this:
 *
 *   - "Use seed data only for local development." This script refuses to run
 *     with NODE_ENV=production, and no application code imports it. The
 *     vocabulary it writes is marked `is_seed = true`, so a team can tell what
 *     they inherited from what they created — and archive any of it, because
 *     taxonomy is theirs (§13).
 *   - "No fake production data in production logic." Nothing here creates
 *     sources, content or media. There are no fake captures and no placeholder
 *     screenshots; the way to get content is to run a real capture, which is
 *     what the acceptance criteria in §35 describe.
 *
 * Idempotent: safe to run repeatedly. Terms are matched on (kind, slug) and
 * settings on key, so re-running updates rather than duplicating.
 */
import { eq, sql } from "drizzle-orm";
import { hashPassword, validatePasswordStrength } from "@uxd/auth";
import { createLogger, slugify, uuidv7 } from "@uxd/shared";
import { loadEnvFile } from "@uxd/shared/env";
import { DEFAULT_TRACKING_PARAMS } from "@uxd/shared";
import {
  DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
  JOB_DEFAULTS,
  type TaxonomyKind,
} from "@uxd/types";
import {
  collectionItems,
  collections,
  contentItems,
  createDatabase,
  settings,
  taxonomyTerms,
  users,
} from "@uxd/database";

loadEnvFile();

const logger = createLogger({ service: "db-seed", level: "info", format: "pretty" });

if (process.env.NODE_ENV === "production") {
  logger.error("Refusing to seed with NODE_ENV=production. Seed data is for development only.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  logger.error("DATABASE_URL is not set. Start the dev database with `npm run db:serve`.");
  process.exit(1);
}

/**
 * The starting vocabulary.
 *
 * Chosen to cover the examples §13 gives and to be immediately useful, not to
 * be exhaustive — an over-large vocabulary is worse than a small one, because
 * a reviewer has to scan it on every classification. Teams extend it in the
 * CMS.
 *
 * Aliases matter more than they look: they are what let a classification
 * suggestion of "hamburger menu" or "tab bar" resolve to the team's canonical
 * term instead of being dropped.
 */
interface SeedTerm {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly children?: readonly SeedTerm[];
}

const VOCABULARY: Partial<Record<TaxonomyKind, readonly SeedTerm[]>> = {
  industry: [
    { name: "Finance", children: [{ name: "Consumer banking" }, { name: "Payments" }, { name: "Investing" }, { name: "Insurance" }] },
    { name: "Software", children: [{ name: "Developer tools" }, { name: "Productivity" }, { name: "Design tools" }, { name: "Analytics" }] },
    { name: "Commerce", children: [{ name: "Marketplace" }, { name: "Direct to consumer" }, { name: "Grocery" }] },
    { name: "Health", children: [{ name: "Telehealth" }, { name: "Fitness" }, { name: "Mental health" }] },
    { name: "Education", children: [{ name: "Language learning" }, { name: "Higher education" }] },
    { name: "Media", children: [{ name: "Streaming" }, { name: "Publishing" }, { name: "Music" }] },
    { name: "Travel", children: [{ name: "Booking" }, { name: "Mobility" }] },
    { name: "Government" },
    { name: "Non-profit" },
  ],

  page_type: [
    { name: "Home", aliases: ["homepage", "landing page", "index"] },
    {
      name: "Marketing",
      children: [
        { name: "Pricing", aliases: ["plans", "price page", "pricing page"] },
        { name: "Product", aliases: ["features", "product page"] },
        { name: "Case study", aliases: ["customer story"] },
        { name: "Comparison", aliases: ["versus", "alternatives"] },
      ],
    },
    {
      name: "Auth",
      children: [
        { name: "Log in", aliases: ["signin", "sign in", "login"] },
        { name: "Sign up", aliases: ["register", "registration", "create account"] },
        { name: "Password reset", aliases: ["forgot password"] },
      ],
    },
    { name: "Documentation", aliases: ["docs", "developer docs", "guide", "api reference"] },
    { name: "Blog index", aliases: ["blog listing", "articles"] },
    { name: "Blog post", aliases: ["article", "post"] },
    { name: "Search results", aliases: ["search", "results"] },
    { name: "Checkout", aliases: ["cart", "basket", "payment"] },
    { name: "Settings", aliases: ["preferences", "account settings"] },
    { name: "Dashboard", aliases: ["overview", "home dashboard"] },
    { name: "Contact", aliases: ["contact us", "get in touch"] },
    { name: "About", aliases: ["about us", "company"] },
    { name: "Careers", aliases: ["jobs", "hiring"] },
    { name: "Legal", aliases: ["terms", "privacy policy", "terms of service"] },
    { name: "Error", aliases: ["404", "not found", "error page"] },
  ],

  screen_type: [
    {
      name: "Onboarding",
      children: [
        { name: "Welcome", aliases: ["splash", "intro"] },
        { name: "Permission request", aliases: ["permissions", "ats prompt"] },
        { name: "Profile setup" },
        { name: "Tutorial", aliases: ["walkthrough", "coach marks"] },
      ],
    },
    { name: "Feed", aliases: ["timeline", "home feed"] },
    { name: "Detail", aliases: ["detail view", "item detail"] },
    { name: "Composer", aliases: ["create", "new post", "editor"] },
    { name: "Profile", aliases: ["account", "user profile"] },
    { name: "Settings" },
    { name: "Paywall", aliases: ["upgrade", "subscription prompt"] },
    { name: "Empty state" },
    { name: "Confirmation", aliases: ["success", "done"] },
    { name: "Identity verification", aliases: ["kyc", "document capture", "id check"] },
    { name: "List" },
  ],

  ux_pattern: [
    {
      name: "Onboarding",
      description: "How a product introduces itself and gets someone to a first success.",
      children: [
        { name: "Progressive onboarding", aliases: ["progressive disclosure onboarding", "just in time onboarding"] },
        { name: "Personalized onboarding", aliases: ["personalised onboarding", "tailored setup"] },
        { name: "Permission gating", aliases: ["permission priming"] },
        { name: "Empty state guidance", aliases: ["blank slate"] },
      ],
    },
    {
      name: "Authentication",
      children: [
        { name: "Social sign-in", aliases: ["oauth login", "sign in with"] },
        { name: "Magic link", aliases: ["passwordless"] },
        { name: "Two-factor", aliases: ["2fa", "mfa"] },
      ],
    },
    { name: "Search", children: [{ name: "Faceted search", aliases: ["filters", "refinement"] }, { name: "Typeahead", aliases: ["autocomplete", "instant search"] }] },
    { name: "Checkout", children: [{ name: "Single-page checkout" }, { name: "Multi-step checkout", aliases: ["stepped checkout"] }, { name: "Guest checkout" }] },
    { name: "Consent", aliases: ["cookie consent", "gdpr banner"] },
    { name: "Pricing comparison", aliases: ["plan comparison", "tier comparison"] },
    { name: "Social proof", aliases: ["testimonials", "logos", "reviews"] },
    { name: "Progressive disclosure" },
    { name: "Undo", aliases: ["undo toast"] },
    { name: "Error recovery", aliases: ["inline validation", "error handling"] },
  ],

  ui_pattern: [
    {
      name: "Hero section",
      description: "The first thing a page shows: the headline, the promise and the first action.",
      aliases: ["hero", "above the fold", "hero banner", "masthead"],
    },
    {
      name: "Navigation",
      children: [
        { name: "Sidebar", aliases: ["side nav", "left nav", "rail"] },
        { name: "Bottom navigation", aliases: ["tab bar", "bottom nav", "bottom tabs"] },
        { name: "Mega menu", aliases: ["dropdown navigation"] },
        { name: "Hamburger menu", aliases: ["burger menu", "mobile menu"] },
        { name: "Breadcrumbs" },
        { name: "Command palette", aliases: ["cmd k", "quick switcher"] },
      ],
    },
    { name: "Modal", aliases: ["dialog", "overlay", "lightbox"] },
    { name: "Drawer", aliases: ["sheet", "bottom sheet", "side panel"] },
    { name: "Tabs", aliases: ["tabbed interface", "segmented control"] },
    { name: "Accordion", aliases: ["collapsible", "disclosure", "expander"] },
    { name: "Carousel", aliases: ["slider", "slideshow"] },
    { name: "Data table", aliases: ["table", "grid", "list view"] },
    { name: "Card grid", aliases: ["cards", "tile grid"] },
    { name: "Form", aliases: ["input form"] },
    { name: "Toast", aliases: ["snackbar", "notification"] },
    { name: "Tooltip", aliases: ["hint", "popover"] },
    { name: "Stepper", aliases: ["wizard", "progress steps"] },
    { name: "Skeleton loading", aliases: ["skeleton", "placeholder loading"] },
    { name: "Infinite scroll", aliases: ["endless scroll"] },
    { name: "Pagination" },
    { name: "Sidebar footer" },
    { name: "Footer" },
    { name: "Video", aliases: ["embedded video", "video player"] },
    { name: "Comparison table", aliases: ["feature matrix", "plan comparison", "pricing table"] },
    { name: "Metric card", aliases: ["stat card", "kpi card", "big number"] },
    { name: "Order summary", aliases: ["cart summary", "basket", "line items"] },
    { name: "Sticky action", aliases: ["sticky cta", "pinned button", "fixed footer button"] },
    { name: "Toolbar", aliases: ["action bar", "ribbon"] },
    { name: "Filter rail", aliases: ["filter sidebar", "faceted filters"] },
    { name: "Board", aliases: ["kanban", "column board", "swimlanes"] },
    { name: "Checklist", aliases: ["todo list", "task list"] },
  ],

  component: [
    { name: "Button", children: [{ name: "Primary button" }, { name: "Icon button" }, { name: "Split button" }] },
    { name: "Input", children: [{ name: "Text input" }, { name: "Combobox", aliases: ["select with search", "autocomplete input"] }, { name: "Date picker" }, { name: "File upload", aliases: ["dropzone"] }, { name: "Toggle", aliases: ["switch"] }, { name: "Checkbox" }, { name: "Radio group" }, { name: "Slider" }] },
    { name: "Avatar" },
    { name: "Badge", aliases: ["chip", "tag", "pill"] },
    { name: "Dialog" },
    { name: "Table" },
    { name: "Chart", aliases: ["graph", "visualisation"] },
    { name: "Progress bar" },
    { name: "Banner", aliases: ["alert", "callout"] },
    { name: "Pricing toggle", aliases: ["billing toggle", "monthly annual switch"] },
    { name: "Inline validation", aliases: ["field error", "live validation"] },
    { name: "Sort control", aliases: ["sort", "order by"] },
  ],

  interaction_type: [
    { name: "Hover" },
    { name: "Click" },
    { name: "Focus" },
    { name: "Scroll" },
    { name: "Dropdown" },
    { name: "Modal" },
    { name: "Accordion" },
    { name: "Tabs" },
    { name: "Carousel" },
    { name: "Menu" },
    { name: "Tooltip" },
    { name: "Drawer" },
    { name: "Form fill" },
    { name: "Drag" },
    { name: "Keyboard" },
  ],

  design_style: [
    { name: "Minimal", children: [{ name: "Swiss", aliases: ["international style"] }, { name: "Monochrome" }] },
    { name: "Brutalist", aliases: ["neubrutalism", "brutalism"] },
    { name: "Glassmorphism", aliases: ["frosted glass"] },
    { name: "Neumorphism", aliases: ["soft ui"] },
    { name: "Editorial", aliases: ["magazine"] },
    { name: "Playful", aliases: ["illustrative"] },
    { name: "Corporate", aliases: ["enterprise"] },
    { name: "Dark mode", aliases: ["dark theme"] },
    { name: "Gradient heavy", aliases: ["gradients"] },
    { name: "Retro", aliases: ["nostalgic", "vintage"] },
  ],

  platform: [
    { name: "Web", aliases: ["browser", "website"] },
    { name: "iOS", aliases: ["iphone", "ipados", "apple"] },
    { name: "Android", aliases: ["google play"] },
    { name: "macOS", aliases: ["mac", "desktop app"] },
    { name: "Windows" },
    { name: "tvOS", aliases: ["apple tv"] },
    { name: "watchOS", aliases: ["apple watch"] },
  ],

  device: [
    { name: "Desktop" },
    { name: "Laptop" },
    { name: "Tablet", aliases: ["ipad"] },
    { name: "Mobile", aliases: ["phone", "handset"] },
    { name: "TV" },
    { name: "Watch", aliases: ["wearable"] },
  ],

  state: [
    { name: "Default", aliases: ["resting", "normal"] },
    { name: "Empty state", aliases: ["empty", "zero state", "blank slate"] },
    { name: "Loading", aliases: ["pending", "busy"] },
    { name: "Skeleton" },
    { name: "Error", aliases: ["error state", "failure"] },
    { name: "Success", aliases: ["confirmation", "done"] },
    { name: "Filled", aliases: ["populated", "with data"] },
    { name: "Disabled" },
    { name: "Logged out", aliases: ["anonymous", "unauthenticated"] },
    { name: "Logged in", aliases: ["authenticated", "signed in"] },
    { name: "First run", aliases: ["first launch", "new user"] },
    { name: "Offline", aliases: ["no connection"] },
    { name: "Paywalled", aliases: ["gated", "locked"] },
    { name: "Cookie consent", aliases: ["consent banner"] },
  ],

  function: [
    { name: "Discover", children: [{ name: "Browse" }, { name: "Search" }, { name: "Compare" }] },
    { name: "Purchase", children: [{ name: "Checkout" }, { name: "Subscribe" }, { name: "Manage billing" }] },
    { name: "Create", children: [{ name: "Compose" }, { name: "Upload" }, { name: "Configure" }] },
    { name: "Communicate", children: [{ name: "Message" }, { name: "Comment" }, { name: "Share" }] },
    { name: "Learn", children: [{ name: "Read documentation" }, { name: "Follow a tutorial" }] },
    { name: "Manage account", children: [{ name: "Sign in" }, { name: "Update settings" }, { name: "Invite a teammate" }] },
    { name: "Analyse", children: [{ name: "View a report" }, { name: "Filter data" }] },
  ],

  tag: [],
};

/**
 * Operator-editable settings, with their defaults.
 *
 * These exist so §37's "no hardcoded taxonomy / no hardcoded URLs" extends to
 * the pipeline's own tunables: the tracking-parameter list used for URL
 * normalisation, default crawl limits, and the classification confidence
 * floor are all data a team can change without a deploy.
 */
const DEFAULT_SETTINGS: readonly { key: string; value: unknown; description: string }[] = [
  {
    key: "ingestion.trackingParams",
    value: DEFAULT_TRACKING_PARAMS,
    description:
      "Query parameters stripped when normalising a URL. Two addresses that differ only by these are treated as the same page. Add your own campaign parameters here.",
  },
  {
    key: "ingestion.blockedDomains",
    value: [],
    description:
      "Domains that will never be crawled, whoever submits them. Subdomains are covered. Entries here override any job configuration.",
  },
  {
    key: "ingestion.defaultLimits",
    value: {
      maxDepth: JOB_DEFAULTS.maxDepth,
      maxPagesPerDomain: JOB_DEFAULTS.maxPagesPerDomain,
      maxPagesTotal: JOB_DEFAULTS.maxPagesTotal,
      requestsPerMinutePerDomain: JOB_DEFAULTS.requestsPerMinutePerDomain,
      maxAttempts: JOB_DEFAULTS.maxAttempts,
    },
    description:
      "Defaults pre-filled on the job configuration screen. A job can lower these but never exceed the hard system limits.",
  },
  {
    key: "classification.minAutoApplyConfidence",
    value: DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
    description:
      "Confidence a suggestion would need before it could ever be applied without review. Nothing is auto-applied in this version; this is the floor that would govern it.",
  },
  {
    key: "review.requireNoteOnReject",
    value: true,
    description:
      "Require a written reason when rejecting content, so a rejected record explains itself months later.",
  },
  {
    key: "media.retainBytesOnDelete",
    value: false,
    description:
      "When deleting media, keep the stored file and only hide the record. Off by default: a delete should remove the bytes, while the provenance row always survives.",
  },
];

async function main(): Promise<void> {
  const handle = createDatabase({ url: url!, poolMax: 2, applicationName: "uxd-seed" });

  try {
    // --- Settings ------------------------------------------------------
    for (const setting of DEFAULT_SETTINGS) {
      await handle.db
        .insert(settings)
        .values({ key: setting.key, value: setting.value, description: setting.description })
        .onConflictDoUpdate({
          target: settings.key,
          // Only the description is refreshed: an operator's changed *value*
          // must survive a re-seed, or the seed becomes a way to silently
          // revert their configuration.
          set: { description: setting.description },
        });
    }
    logger.info("Settings ensured", { count: DEFAULT_SETTINGS.length });

    // --- Taxonomy ------------------------------------------------------
    let created = 0;
    let updated = 0;

    const upsertTerm = async (
      kind: TaxonomyKind,
      term: SeedTerm,
      parent: { id: string; path: string; depth: number } | null,
    ): Promise<void> => {
      const slug = slugify(term.name);
      const path = parent ? `${parent.path}/${slug}` : slug;
      const depth = parent ? parent.depth + 1 : 0;

      const existing = await handle.db
        .select({ id: taxonomyTerms.id })
        .from(taxonomyTerms)
        .where(sql`${taxonomyTerms.kind} = ${kind} and ${taxonomyTerms.slug} = ${slug}`)
        .limit(1);

      let id: string;
      if (existing[0]) {
        id = existing[0].id;
        await handle.db
          .update(taxonomyTerms)
          .set({
            name: term.name,
            description: term.description ?? null,
            aliases: [...(term.aliases ?? [])],
            parentId: parent?.id ?? null,
            path,
            depth,
            updatedAt: new Date(),
          })
          .where(eq(taxonomyTerms.id, id));
        updated += 1;
      } else {
        id = uuidv7();
        await handle.db.insert(taxonomyTerms).values({
          id,
          kind,
          parentId: parent?.id ?? null,
          name: term.name,
          slug,
          description: term.description ?? null,
          aliases: [...(term.aliases ?? [])],
          status: "active",
          path,
          depth,
          isSeed: true,
        });
        created += 1;
      }

      for (const child of term.children ?? []) {
        await upsertTerm(kind, child, { id, path, depth });
      }
    };

    for (const [kind, terms] of Object.entries(VOCABULARY) as [TaxonomyKind, SeedTerm[]][]) {
      for (const term of terms) await upsertTerm(kind, term, null);
    }
    logger.info("Taxonomy seeded", { created, updated });

    // --- Admin user ----------------------------------------------------
    const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@localhost").toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? "change-me-in-development";

    const existingUser = await handle.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existingUser[0]) {
      logger.info("Admin user already exists; leaving it alone", { email });
    } else {
      const strength = validatePasswordStrength(password);
      if (!strength.ok) {
        logger.error(
          "SEED_ADMIN_PASSWORD is too weak. Set a stronger one, or omit it to use the default.",
          { reason: strength.message },
        );
        process.exitCode = 1;
        return;
      }

      await handle.db.insert(users).values({
        id: uuidv7(),
        email,
        name: process.env.SEED_ADMIN_NAME ?? "Local Admin",
        role: "admin",
        status: "active",
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
      });

      logger.info("Admin user created", { email });
      if (password === "change-me-in-development") {
        // The password is not logged as a field: the logger redacts anything
        // that looks like a credential, which is correct, and would render the
        // message useless. It is named in the message because it is a
        // documented constant, not a secret.
        logger.warn(
          `The default development password "change-me-in-development" was used for ${email}. ` +
            "Sign in, change it, and never use this in a deployed environment. " +
            "Set SEED_ADMIN_PASSWORD to choose your own.",
        );
      }
    }

    // --- An empty starter collection -----------------------------------
    //
    // Created empty and populated from whatever the database already holds,
    // rather than shipped with fabricated members: §37 rules out fake
    // production data in production logic, and a collection whose items do not
    // exist would be exactly that. If a developer has captured something, this
    // gives them a collection to look at; if not, it gives them an empty one,
    // which is also a state worth being able to see.
    const collectionSlug = "starter-set";
    const existingCollection = await handle.db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.slug, collectionSlug))
      .limit(1);

    let collectionId = existingCollection[0]?.id;
    if (!collectionId) {
      collectionId = uuidv7();
      await handle.db.insert(collections).values({
        id: collectionId,
        name: "Starter set",
        slug: collectionSlug,
        description:
          "A place to put the first few captures while getting a feel for the review and publishing flow. Internal until you make it public.",
        visibility: "internal",
        status: "active",
        module: "web",
      });
      logger.info("Starter collection created", { slug: collectionSlug });
    }

    // Fill it with up to six records it does not already contain, so the
    // collection screens have something to render on a database that has been
    // used at all.
    const candidates = await handle.db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(
        sql`${contentItems.deletedAt} is null
          and ${contentItems.id} not in (
            select content_item_id from ${collectionItems} where collection_id = ${collectionId}
          )`,
      )
      .limit(6);

    if (candidates.length > 0) {
      const [counted] = await handle.db
        .select({ n: sql<number>`count(*)::int` })
        .from(collectionItems)
        .where(eq(collectionItems.collectionId, collectionId));
      const existingCount = counted?.n ?? 0;

      await handle.db.insert(collectionItems).values(
        candidates.map((row, index) => ({
          id: uuidv7(),
          collectionId: collectionId!,
          contentItemId: row.id,
          position: existingCount + index,
        })),
      );

      // The maintained counter, recomputed rather than incremented so a
      // re-seed cannot double it.
      await handle.db
        .update(collections)
        .set({
          itemCount: sql`(
            select count(*)::int from ${collectionItems}
            where collection_id = ${collections}.id
          )`,
          updatedAt: new Date(),
        })
        .where(eq(collections.id, collectionId));

      logger.info("Starter collection populated", { added: candidates.length });
    }

    logger.info("Seed complete. Sign in at the CMS and create a source to begin.", { email });
  } catch (error) {
    logger.error("Seed failed", { error });
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

await main();
