import { pgTable, check, uuid, text, timestamp, index, foreignKey, unique, uniqueIndex, jsonb, bigint, boolean, integer, numeric } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const organizations = pgTable("organizations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	currency: text().default('USD').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("organizations_currency_check", sql`currency ~ '^[A-Z]{3}$'::text`),
]);

export const memberships = pgTable("memberships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: text().default('owner').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("memberships_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "memberships_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "memberships_user_id_fkey"
		}).onDelete("cascade"),
	unique("memberships_org_id_user_id_key").on(table.orgId, table.userId),
	check("memberships_role_check", sql`role = ANY (ARRAY['owner'::text, 'member'::text])`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	name: text(),
	emailVerified: timestamp("email_verified", { withTimezone: true, mode: 'string' }),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("users_email_key").on(table.email),
]);

export const projects = pgTable("projects", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	domain: text(),
	noWebsiteAnswers: jsonb("no_website_answers"),
	status: text().default('creating').notNull(),
	failureReason: text("failure_reason"),
	analysis: jsonb().default({}).notNull(),
	senderName: text("sender_name").default('').notNull(),
	timezone: text().default('UTC').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dailyBudgetMicros: bigint("daily_budget_micros", { mode: "number" }).default(5000000).notNull(),
	monthlyCapMicros: bigint("monthly_cap_micros", { mode: "number" }),
	facts: text().default('').notNull(),
	autoReplyEnabled: boolean("auto_reply_enabled").default(false).notNull(),
	autoReplyDelayMinutes: integer("auto_reply_delay_minutes").default(30).notNull(),
	bookingUrl: text("booking_url"),
	legalFooter: text("legal_footer").default('').notNull(),
	legalBasisConfirmedAt: timestamp("legal_basis_confirmed_at", { withTimezone: true, mode: 'string' }),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("projects_one_per_domain").using("btree", sql`org_id`, sql`lower(domain)`).where(sql`((domain IS NOT NULL) AND (archived_at IS NULL))`),
	index("projects_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "projects_org_id_fkey"
		}).onDelete("cascade"),
	check("projects_status_check", sql`status = ANY (ARRAY['creating'::text, 'ready'::text, 'failed'::text])`),
	check("projects_daily_budget_micros_check", sql`daily_budget_micros >= 0`),
	check("projects_auto_reply_delay_minutes_check", sql`(auto_reply_delay_minutes >= 5) AND (auto_reply_delay_minutes <= 1440)`),
	check("has_domain_or_answers", sql`(domain IS NOT NULL) OR (no_website_answers IS NOT NULL)`),
]);

export const leadStatuses = pgTable("lead_statuses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id").notNull(),
	name: text().notNull(),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("lead_statuses_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "lead_statuses_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "lead_statuses_project_id_fkey"
		}).onDelete("cascade"),
	unique("lead_statuses_project_id_name_key").on(table.projectId, table.name),
]);

export const campaigns = pgTable("campaigns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id").notNull(),
	name: text().notNull(),
	source: text().default('discovery').notNull(),
	status: text().default('draft').notNull(),
	statusBeforeStop: text("status_before_stop"),
	statusReason: text("status_reason"),
	offer: text(),
	customerProblem: text("customer_problem"),
	targetRole: text("target_role"),
	targetGeography: text("target_geography"),
	targetCompanySize: text("target_company_size"),
	positiveCriteria: text("positive_criteria").array().default([""]).notNull(),
	negativeCriteria: text("negative_criteria").array().default([""]).notNull(),
	exampleClients: text("example_clients").array().default([""]).notNull(),
	keywords: text(),
	instructions: text().default('').notNull(),
	followupInstructions: text("followup_instructions").default('').notNull(),
	replyInstructions: text("reply_instructions").default('').notNull(),
	language: text().default('auto').notNull(),
	useProjectEmail: boolean("use_project_email").default(false).notNull(),
	sendDays: integer("send_days").array().default([1, 2, 3, 4, 5]).notNull(),
	sendStartMinute: integer("send_start_minute").default(540).notNull(),
	sendEndMinute: integer("send_end_minute").default(1020).notNull(),
	maxTouches: integer("max_touches").default(3).notNull(),
	followupDelayDays: integer("followup_delay_days").default(3).notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	approvedBy: uuid("approved_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("campaigns_approved_by_idx").using("btree", table.approvedBy.asc().nullsLast().op("uuid_ops")),
	index("campaigns_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	index("campaigns_project_id_status_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "campaigns_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "campaigns_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.approvedBy],
			foreignColumns: [users.id],
			name: "campaigns_approved_by_fkey"
		}).onDelete("set null"),
	check("campaigns_source_check", sql`source = ANY (ARRAY['discovery'::text, 'import'::text])`),
	check("sending_needs_approval", sql`(status <> 'sending'::text) OR (approved_at IS NOT NULL)`),
	check("campaigns_status_check", sql`status = ANY (ARRAY['draft'::text, 'searching'::text, 'review'::text, 'sending'::text, 'stopped'::text, 'archived'::text])`),
	check("campaigns_status_before_stop_check", sql`status_before_stop = ANY (ARRAY['searching'::text, 'review'::text, 'sending'::text])`),
	check("campaigns_send_start_minute_check", sql`(send_start_minute >= 0) AND (send_start_minute <= 1439)`),
	check("campaigns_send_end_minute_check", sql`(send_end_minute >= 1) AND (send_end_minute <= 1440)`),
	check("campaigns_max_touches_check", sql`(max_touches >= 1) AND (max_touches <= 6)`),
	check("campaigns_followup_delay_days_check", sql`(followup_delay_days >= 1) AND (followup_delay_days <= 30)`),
	check("send_window_order", sql`send_end_minute > send_start_minute`),
]);

export const mailboxes = pgTable("mailboxes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id").notNull(),
	email: text().notNull(),
	displayName: text("display_name").default('').notNull(),
	smtpHost: text("smtp_host").notNull(),
	smtpPort: integer("smtp_port").default(587).notNull(),
	imapHost: text("imap_host").notNull(),
	imapPort: integer("imap_port").default(993).notNull(),
	username: text().notNull(),
	secretEnc: text("secret_enc").notNull(),
	status: text().default('unverified').notNull(),
	statusReason: text("status_reason"),
	dailyLimit: integer("daily_limit").default(30).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	imapUidvalidity: bigint("imap_uidvalidity", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	imapLastUid: bigint("imap_last_uid", { mode: "number" }).default(0).notNull(),
	lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: 'string' }),
	spfOk: boolean("spf_ok"),
	dkimOk: boolean("dkim_ok"),
	dmarcOk: boolean("dmarc_ok"),
	dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mailboxes_project_id_status_idx").using("btree", table.projectId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "mailboxes_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "mailboxes_project_id_fkey"
		}).onDelete("cascade"),
	unique("mailboxes_org_id_email_key").on(table.orgId, table.email),
	check("mailboxes_status_check", sql`status = ANY (ARRAY['unverified'::text, 'active'::text, 'paused'::text, 'failing'::text])`),
	check("mailboxes_daily_limit_check", sql`(daily_limit >= 1) AND (daily_limit <= 200)`),
]);

export const firstEmails = pgTable("first_emails", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id"),
	campaignId: uuid("campaign_id"),
	mode: text().default('instructions').notNull(),
	subject: text().default('').notNull(),
	body: text().default('').notNull(),
	instructions: text().default('').notNull(),
	preview: jsonb().default([]).notNull(),
	autoRevertedAt: timestamp("auto_reverted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("first_emails_campaign").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")).where(sql`(campaign_id IS NOT NULL)`),
	index("first_emails_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("first_emails_project").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")).where(sql`(project_id IS NOT NULL)`),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "first_emails_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "first_emails_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [campaigns.id],
			name: "first_emails_campaign_id_fkey"
		}).onDelete("cascade"),
	check("first_emails_mode_check", sql`mode = ANY (ARRAY['instructions'::text, 'my_copy'::text])`),
	check("one_owner", sql`(project_id IS NULL) <> (campaign_id IS NULL)`),
]);

export const contacts = pgTable("contacts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	email: text(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	jobTitle: text("job_title"),
	linkedinUrl: text("linkedin_url"),
	phone: text(),
	companyName: text("company_name"),
	companyDomain: text("company_domain"),
	companySize: integer("company_size"),
	country: text(),
	source: text().notNull(),
	sourceDetail: text("source_detail"),
	emailStatus: text("email_status").default('unknown').notNull(),
	emailCheckedAt: timestamp("email_checked_at", { withTimezone: true, mode: 'string' }),
	unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true, mode: 'string' }),
	erasedAt: timestamp("erased_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("contacts_one_per_email").using("btree", sql`org_id`, sql`lower(email)`).where(sql`(email IS NOT NULL)`),
	index("contacts_org_id_company_domain_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops"), table.companyDomain.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "contacts_org_id_fkey"
		}).onDelete("cascade"),
	check("contacts_source_check", sql`source = ANY (ARRAY['import'::text, 'provider'::text, 'reply'::text])`),
	check("contacts_email_status_check", sql`email_status = ANY (ARRAY['unknown'::text, 'valid'::text, 'risky'::text, 'invalid'::text])`),
	check("email_unless_erased", sql`(email IS NOT NULL) OR (erased_at IS NOT NULL)`),
]);

export const companyProfiles = pgTable("company_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	domain: text().notNull(),
	summary: text().default('').notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "company_profiles_org_id_fkey"
		}).onDelete("cascade"),
	unique("company_profiles_org_id_domain_key").on(table.orgId, table.domain),
]);

export const leads = pgTable("leads", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	campaignId: uuid("campaign_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	stage: text().default('review').notNull(),
	fitReason: text("fit_reason"),
	fitScore: integer("fit_score"),
	clientRef: text("client_ref"),
	statusId: uuid("status_id"),
	note: text(),
	noteUpdatedAt: timestamp("note_updated_at", { withTimezone: true, mode: 'string' }),
	noteUpdatedBy: uuid("note_updated_by"),
	needsReply: boolean("needs_reply").default(false).notNull(),
	whyHot: text("why_hot"),
	becameHotAt: timestamp("became_hot_at", { withTimezone: true, mode: 'string' }),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	nextTouchAt: timestamp("next_touch_at", { withTimezone: true, mode: 'string' }),
	touchesSent: integer("touches_sent").default(0).notNull(),
	unsubscribeToken: text("unsubscribe_token").default(sql`(replace((gen_random_uuid())::text, \'-\'::text, \'::text) || replace((gen_random_uuid())::text, \'-\'::text, \'::text))`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("leads_campaign_id_needs_reply_last_message_at_idx").using("btree", table.campaignId.asc().nullsLast().op("timestamptz_ops"), table.needsReply.asc().nullsLast().op("bool_ops"), table.lastMessageAt.desc().nullsFirst().op("bool_ops")),
	index("leads_campaign_id_stage_idx").using("btree", table.campaignId.asc().nullsLast().op("text_ops"), table.stage.asc().nullsLast().op("text_ops")),
	index("leads_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("leads_next_touch_at_idx").using("btree", table.nextTouchAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((stage = 'active'::text) AND (next_touch_at IS NOT NULL))`),
	index("leads_note_updated_by_idx").using("btree", table.noteUpdatedBy.asc().nullsLast().op("uuid_ops")),
	index("leads_org_id_became_hot_at_idx").using("btree", table.orgId.asc().nullsLast().op("timestamptz_ops"), table.becameHotAt.desc().nullsFirst().op("uuid_ops")).where(sql`(became_hot_at IS NOT NULL)`),
	index("leads_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	index("leads_status_id_idx").using("btree", table.statusId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "leads_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [campaigns.id],
			name: "leads_campaign_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "leads_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.statusId],
			foreignColumns: [leadStatuses.id],
			name: "leads_status_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.noteUpdatedBy],
			foreignColumns: [users.id],
			name: "leads_note_updated_by_fkey"
		}).onDelete("set null"),
	unique("leads_campaign_id_contact_id_key").on(table.campaignId, table.contactId),
	unique("leads_unsubscribe_token_key").on(table.unsubscribeToken),
	check("leads_stage_check", sql`stage = ANY (ARRAY['review'::text, 'excluded'::text, 'active'::text, 'finished'::text, 'replied'::text, 'bounced'::text, 'stopped'::text])`),
]);

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	leadId: uuid("lead_id").notNull(),
	mailboxId: uuid("mailbox_id"),
	direction: text().notNull(),
	kind: text().notNull(),
	touch: integer(),
	status: text().notNull(),
	statusReason: text("status_reason"),
	subject: text(),
	bodyText: text("body_text"),
	fromEmail: text("from_email"),
	toEmail: text("to_email"),
	rfcMessageId: text("rfc_message_id"),
	inReplyTo: text("in_reply_to"),
	referencesHeader: text("references_header"),
	intent: text(),
	intentConfidence: numeric("intent_confidence", { precision: 3, scale:  2 }),
	intentReason: text("intent_reason"),
	needsDraft: boolean("needs_draft").default(false).notNull(),
	translation: text(),
	sendAfter: timestamp("send_after", { withTimezone: true, mode: 'string' }),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }),
	erasedAt: timestamp("erased_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("messages_claimed_at_idx").using("btree", table.claimedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'sending'::text)`),
	index("messages_lead_id_created_at_idx").using("btree", table.leadId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("uuid_ops")),
	index("messages_mailbox_id_sent_at_idx").using("btree", table.mailboxId.asc().nullsLast().op("uuid_ops"), table.sentAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("messages_one_per_touch").using("btree", table.leadId.asc().nullsLast().op("uuid_ops"), table.touch.asc().nullsLast().op("uuid_ops")).where(sql`((touch IS NOT NULL) AND (status <> 'cancelled'::text))`),
	index("messages_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("messages_rfc_id").using("btree", table.orgId.asc().nullsLast().op("uuid_ops"), table.rfcMessageId.asc().nullsLast().op("uuid_ops")).where(sql`(rfc_message_id IS NOT NULL)`),
	index("messages_status_send_after_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.sendAfter.asc().nullsLast().op("text_ops")).where(sql`(status = 'queued'::text)`),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "messages_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "messages_lead_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.mailboxId],
			foreignColumns: [mailboxes.id],
			name: "messages_mailbox_id_fkey"
		}).onDelete("set null"),
	check("messages_direction_check", sql`direction = ANY (ARRAY['outbound'::text, 'inbound'::text])`),
	check("messages_kind_check", sql`kind = ANY (ARRAY['first'::text, 'followup'::text, 'manual_reply'::text, 'auto_reply'::text, 'reply'::text, 'auto_response'::text, 'bounce'::text])`),
	check("messages_status_check", sql`status = ANY (ARRAY['draft'::text, 'queued'::text, 'sending'::text, 'sent'::text, 'unknown'::text, 'failed'::text, 'cancelled'::text, 'received'::text])`),
	check("messages_intent_check", sql`intent = ANY (ARRAY['interested'::text, 'meeting_request'::text, 'question'::text, 'referral'::text, 'not_now'::text, 'not_interested'::text, 'unsubscribe'::text, 'other'::text])`),
	check("messages_intent_confidence_check", sql`(intent_confidence >= (0)::numeric) AND (intent_confidence <= (1)::numeric)`),
	check("touch_on_sequence_mail", sql`(kind = ANY (ARRAY['first'::text, 'followup'::text])) = (touch IS NOT NULL)`),
]);

export const imports = pgTable("imports", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id").notNull(),
	campaignId: uuid("campaign_id"),
	name: text().notNull(),
	status: text().default('pending').notNull(),
	stage: text(),
	done: integer().default(0).notNull(),
	total: integer().default(0).notNull(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sourceCsv: text("source_csv"),
}, (table) => [
	index("imports_campaign_id_idx").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	index("imports_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	index("imports_project_id_idx").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "imports_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "imports_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [campaigns.id],
			name: "imports_campaign_id_fkey"
		}).onDelete("set null"),
	check("imports_status_check", sql`status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])`),
	check("imports_stage_check", sql`stage = ANY (ARRAY['validating'::text, 'verifying'::text, 'deduplicating'::text, 'creating_campaign'::text, 'saving'::text])`),
]);

export const importRows = pgTable("import_rows", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	importId: uuid("import_id").notNull(),
	rowIndex: integer("row_index").notNull(),
	contactId: uuid("contact_id"),
	outcome: text().notNull(),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("import_rows_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("import_rows_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "import_rows_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.importId],
			foreignColumns: [imports.id],
			name: "import_rows_import_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "import_rows_contact_id_fkey"
		}).onDelete("set null"),
	unique("import_rows_import_id_row_index_key").on(table.importId, table.rowIndex),
	check("import_rows_outcome_check", sql`outcome = ANY (ARRAY['imported'::text, 'skipped'::text])`),
	check("import_rows_reason_check", sql`reason = ANY (ARRAY['missing_fields'::text, 'invalid_email'::text, 'duplicate_in_file'::text, 'already_contacted'::text, 'suppressed'::text])`),
]);

export const suppressionLists = pgTable("suppression_lists", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "suppression_lists_org_id_fkey"
		}).onDelete("cascade"),
	unique("suppression_lists_org_id_name_key").on(table.orgId, table.name),
]);

export const suppressionEntries = pgTable("suppression_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	listId: uuid("list_id").notNull(),
	kind: text().notNull(),
	value: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("suppression_entries_org_id_kind_value_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops"), table.kind.asc().nullsLast().op("text_ops"), table.value.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "suppression_entries_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.listId],
			foreignColumns: [suppressionLists.id],
			name: "suppression_entries_list_id_fkey"
		}).onDelete("cascade"),
	unique("suppression_entries_list_id_kind_value_key").on(table.listId, table.kind, table.value),
	check("suppression_entries_kind_check", sql`kind = ANY (ARRAY['email'::text, 'email_hash'::text, 'domain'::text])`),
]);

export const spendEvents = pgTable("spend_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	projectId: uuid("project_id").notNull(),
	campaignId: uuid("campaign_id"),
	kind: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
	currency: text().default('USD').notNull(),
	detail: jsonb().default({}).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("spend_events_campaign_id_occurred_at_idx").using("btree", table.campaignId.asc().nullsLast().op("timestamptz_ops"), table.occurredAt.asc().nullsLast().op("uuid_ops")),
	index("spend_events_org_id_idx").using("btree", table.orgId.asc().nullsLast().op("uuid_ops")),
	index("spend_events_project_id_occurred_at_idx").using("btree", table.projectId.asc().nullsLast().op("uuid_ops"), table.occurredAt.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "spend_events_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "spend_events_project_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [campaigns.id],
			name: "spend_events_campaign_id_fkey"
		}).onDelete("set null"),
	check("spend_events_kind_check", sql`kind = ANY (ARRAY['ai'::text, 'lead_data'::text, 'email_verification'::text, 'mailbox'::text])`),
	check("spend_events_amount_micros_check", sql`amount_micros >= 0`),
	check("spend_events_currency_check", sql`currency ~ '^[A-Z]{3}$'::text`),
]);

export const auditEvents = pgTable("audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	actorUserId: uuid("actor_user_id"),
	actor: text().notNull(),
	action: text().notNull(),
	subjectType: text("subject_type").notNull(),
	subjectId: uuid("subject_id"),
	detail: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("audit_events_actor_user_id_idx").using("btree", table.actorUserId.asc().nullsLast().op("uuid_ops")),
	index("audit_events_org_id_created_at_idx").using("btree", table.orgId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("audit_events_subject_type_subject_id_idx").using("btree", table.subjectType.asc().nullsLast().op("uuid_ops"), table.subjectId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "audit_events_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "audit_events_actor_user_id_fkey"
		}).onDelete("set null"),
	check("audit_events_actor_check", sql`actor = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text])`),
]);
