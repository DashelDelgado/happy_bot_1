import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import * as dotenv from "dotenv";
import mongoose from "mongoose";
import { Context, Telegraf } from "telegraf";
import { isAdminUser as isAdminUserId, parseAdminIds } from "./admin.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_ID);
const BACKUP_IDS = parseAdminIds(process.env.BACKUP);
const SEND_DELAY_MS = Number.parseInt(process.env.SEND_DELAY_MS ?? "3000", 10);
const ALBUM_FLUSH_DELAY_MS = Number.parseInt(
  process.env.ALBUM_FLUSH_DELAY_MS ?? "2500",
  10,
);
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const STATE_FILE = path.join(process.cwd(), "state.json");

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in the environment.");
}

type MediaType = "photo" | "video" | "document" | "video_note";
interface MediaItem {
  type: MediaType;
  fileId: string;
  caption?: string;
}

interface UserSettings {
  albumModeEnabled?: boolean;
  captionEnabled?: boolean;
  addCaptionEnabled?: boolean;
  captionText?: string;
  senderModeEnabled?: boolean;
}

interface PendingQueue {
  chatId: number;
  targetIds: number[];
  items: MediaItem[];
  timer: NodeJS.Timeout | null;
  senderName?: string;
}

interface PendingIncomingMediaGroup {
  targetIds: number[];
  userId: number;
  items: MediaItem[];
  timer: NodeJS.Timeout | null;
  senderName?: string;
}

interface PersistedState {
  users: Record<string, UserSettings>;
}

interface UserDoc {
  userId: number;
  firstName?: string;
  username?: string;
  targetId?: number;
  targetIds?: number[];
  isAdmin?: boolean;
  hidden?: boolean;
  isVerified?: boolean;
  inviteCodeUsed?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface InviteCodeDoc {
  code: string;
  isActive: boolean;
  usesCount: number;
  usedBy: number[];
  createdBy?: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const bot = new Telegraf(BOT_TOKEN);
const settingsByUserId = new Map<number, UserSettings>();
const pendingQueues = new Map<number, PendingQueue>();
const incomingMediaGroups = new Map<string, PendingIncomingMediaGroup>();
const pendingMultiTargetSelections = new Map<number, Set<number>>();
const userLastSent = new Map<number, number>();
const pendingInviteUsers = new Set<number>();
const invalidInviteWarnedUsers = new Set<number>();
let botUsername = "";
let mongoReady = false;
let botReady = false;
let httpServer: http.Server | null = null;
const botCommands = [
  { command: "start", description: "Show the welcome message" },
  { command: "join", description: "Join with an invitation code" },
  { command: "album_mode", description: "Toggle album mode on or off" },
  { command: "caption", description: "Toggle caption preservation" },
  { command: "add_caption", description: "Toggle custom caption text" },
  { command: "caption_text", description: "Set the custom caption text" },
  { command: "mode_sender", description: "Toggle sender forwarding mode" },
  { command: "set_target", description: "Set the target user ID" },
  { command: "set_multi_target", description: "Select multiple target users" },
  { command: "get_target", description: "Show the current target" },
  { command: "change_target", description: "Change the target user ID" },
  { command: "create_invite", description: "Create an invitation code" },
  { command: "disable_invite", description: "Disable an invitation code" },
  { command: "list_invites", description: "List invitation codes" },
  { command: "stats", description: "List available users (admin)" },
  {
    command: "hide",
    description: "<id> - Hide a user from target lists (admin)",
  },
  { command: "status", description: "Show the current settings" },
  { command: "help", description: "Show the command list" },
];

const userSchema = new mongoose.Schema<UserDoc>(
  {
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String },
    username: { type: String },
    targetId: { type: Number },
    targetIds: { type: [Number], default: [] },
    isAdmin: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    inviteCodeUsed: { type: String },
  },
  { timestamps: true },
);

const inviteCodeSchema = new mongoose.Schema<InviteCodeDoc>(
  {
    code: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    usesCount: { type: Number, default: 0 },
    usedBy: { type: [Number], default: [] },
    createdBy: { type: Number },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

const UserModel = mongoose.model<UserDoc>("User", userSchema);
const InviteCodeModel = mongoose.model<InviteCodeDoc>(
  "InviteCode",
  inviteCodeSchema,
);

function readPersistedState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;

    for (const [userIdText, settings] of Object.entries(parsed.users ?? {})) {
      const userId = Number(userIdText);
      if (Number.isNaN(userId)) {
        continue;
      }

      settingsByUserId.set(userId, {
        albumModeEnabled: settings.albumModeEnabled,
        captionEnabled: settings.captionEnabled,
        addCaptionEnabled: settings.addCaptionEnabled,
        captionText: settings.captionText,
        senderModeEnabled: settings.senderModeEnabled,
      });
    }
  } catch (error) {
    console.warn("Failed to load persisted state:", error);
  }
}

async function savePersistedState(): Promise<void> {
  try {
    const users: Record<string, UserSettings> = {};

    for (const [userId, settings] of settingsByUserId.entries()) {
      users[String(userId)] = {
        albumModeEnabled: settings.albumModeEnabled,
        captionEnabled: settings.captionEnabled,
        addCaptionEnabled: settings.addCaptionEnabled,
        captionText: settings.captionText,
        senderModeEnabled: settings.senderModeEnabled,
      };
    }

    const payload: PersistedState = { users };
    await fsp.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to save persisted state:", error);
  }
}

function getUserSettings(userId: number): UserSettings {
  return settingsByUserId.get(userId) ?? {};
}

function isAlbumModeEnabled(userId: number): boolean {
  return getUserSettings(userId).albumModeEnabled ?? true;
}

function isCaptionEnabled(userId: number): boolean {
  return getUserSettings(userId).captionEnabled ?? false;
}

function isAddCaptionEnabled(userId: number): boolean {
  return getUserSettings(userId).addCaptionEnabled ?? false;
}

function isSenderModeEnabled(userId: number): boolean {
  return getUserSettings(userId).senderModeEnabled ?? false;
}

function getCaptionText(userId: number): string {
  return getUserSettings(userId).captionText?.trim() ?? "";
}

function setAlbumModeEnabled(userId: number, enabled: boolean): void {
  settingsByUserId.set(userId, {
    ...getUserSettings(userId),
    albumModeEnabled: enabled,
  });

  if (!enabled) {
    const pending = pendingQueues.get(userId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pendingQueues.delete(userId);
  }
}

function setCaptionEnabled(userId: number, enabled: boolean): void {
  settingsByUserId.set(userId, {
    ...getUserSettings(userId),
    captionEnabled: enabled,
  });
}

function setAddCaptionEnabled(userId: number, enabled: boolean): void {
  settingsByUserId.set(userId, {
    ...getUserSettings(userId),
    addCaptionEnabled: enabled,
  });
}

function setCaptionText(userId: number, captionText: string): void {
  settingsByUserId.set(userId, {
    ...getUserSettings(userId),
    captionText,
  });
}

function setSenderModeEnabled(userId: number, enabled: boolean): void {
  settingsByUserId.set(userId, {
    ...getUserSettings(userId),
    senderModeEnabled: enabled,
  });
}

function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

async function connectMongo(): Promise<void> {
  if (!MONGO_URI) {
    console.warn(
      "MONGO_URI not set. Sender and invite features will be unavailable.",
    );
    return;
  }

  try {
    await mongoose.connect(MONGO_URI);
    mongoReady = true;
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    mongoReady = false;
    console.error("❌ MongoDB connection failed:", error);
  }
}

function isAdminUser(userId: number): boolean {
  return isAdminUserId(userId, ADMIN_IDS);
}

async function isAuthorizedUser(userId: number): Promise<boolean> {
  if (isAdminUser(userId)) {
    return true;
  }

  if (!mongoReady) {
    return false;
  }

  const user = await UserModel.findOne({ userId }).lean();
  return Boolean(user?.isVerified);
}

async function ensureAuthorizedUser(
  ctx: Context,
  userId?: number,
): Promise<boolean> {
  if (!userId) {
    await ctx.reply("User ID not found.");
    return false;
  }

  if (await isAuthorizedUser(userId)) {
    return true;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Registration is unavailable right now.",
    );
    return false;
  }

  await ctx.reply(
    "🔐 Access restricted.\n\nUse /join <invite_code> to activate your access.",
  );
  return false;
}

async function syncUserProfile(
  ctx: Context,
  options?: { verify?: boolean; inviteCodeUsed?: string; forceAdmin?: boolean },
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !mongoReady) {
    return;
  }

  await UserModel.updateOne(
    { userId },
    {
      $set: {
        firstName: ctx.from?.first_name,
        username: ctx.from?.username,
        isVerified: options?.verify ?? true,
        isAdmin: options?.forceAdmin ?? isAdminUser(userId),
        inviteCodeUsed: options?.inviteCodeUsed,
      },
    },
    { upsert: true },
  );
}

async function validateInviteCode(code: string): Promise<boolean> {
  if (!mongoReady) {
    return false;
  }

  const invite = await InviteCodeModel.findOne({ code, isActive: true });
  return Boolean(invite);
}

async function getTargetIds(userId: number): Promise<number[]> {
  if (!mongoReady) {
    return [];
  }

  const user = await UserModel.findOne({ userId }).lean();
  const rawTargets = [
    ...(user?.targetIds ?? []),
    ...(user?.targetId ? [user.targetId] : []),
  ];
  return Array.from(
    new Set(rawTargets.filter((target) => target && target !== userId)),
  );
}

async function setTarget(userId: number, targetId: number): Promise<void> {
  await setTargets(userId, [targetId]);
}

async function setTargets(userId: number, targetIds: number[]): Promise<void> {
  if (!mongoReady) {
    return;
  }

  const uniqueTargetIds = Array.from(
    new Set(targetIds.filter((targetId) => targetId && targetId !== userId)),
  );

  await UserModel.updateOne(
    { userId },
    {
      $set: {
        targetId: uniqueTargetIds[0],
        targetIds: uniqueTargetIds,
      },
    },
    { upsert: true },
  );
}

async function getSelectableTargets(
  userId: number,
): Promise<Array<{ userId: number; firstName?: string; username?: string }>> {
  if (!mongoReady) return [];

  const users = await UserModel.find({
    userId: { $ne: userId },
    isVerified: true,
    hidden: { $ne: true },
  })
    .select("userId firstName username")
    .lean();

  return users.map((user) => ({
    userId: user.userId,
    firstName: user.firstName,
    username: user.username,
  }));
}

function buildMultiTargetKeyboard(
  users: Array<{ userId: number; firstName?: string; username?: string }>,
  selected: Set<number>,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let index = 0; index < users.length; index += 2) {
    buttons.push(
      users.slice(index, index + 2).map((user) => ({
        text: `${selected.has(user.userId) ? "✅" : "⬜"} ${user.firstName || user.username || user.userId}`,
        callback_data: `multi_target_toggle_${user.userId}`,
      })),
    );
  }

  buttons.push([
    { text: "✅ Confirm", callback_data: "multi_target_confirm" },
    { text: "🧹 Clear", callback_data: "multi_target_clear" },
  ]);
  buttons.push([{ text: "❌ Cancel", callback_data: "multi_target_cancel" }]);
  return buttons;
}

function buildSingleTargetKeyboard(
  users: Array<{ userId: number; firstName?: string; username?: string }>,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < users.length; index += 2) {
    buttons.push(
      users.slice(index, index + 2).map((user) => ({
        text: user.firstName || user.username || String(user.userId),
        callback_data: `single_target_set_${user.userId}`,
      })),
    );
  }
  return buttons;
}

function buildMultiTargetPrompt(selectedCount: number): string {
  return `🎯 <b>Select one or more recipients</b>\n\nTap users, then press <b>Confirm</b>.\nSelected: <b>${selectedCount}</b>`;
}

async function getTargetLabel(userId: number): Promise<string> {
  const targets = await getTargetIds(userId);
  if (!targets.length) {
    return "not set";
  }

  const users = await UserModel.find({ userId: { $in: targets } })
    .select("userId firstName username")
    .lean();
  const usersById = new Map(users.map((user) => [user.userId, user]));

  return targets
    .map((targetId) => {
      const user = usersById.get(targetId);
      const name = user?.firstName || "Unknown user";
      const username = user?.username ? `@${user.username}` : "no username";
      return `${name} (${username}) [${targetId}]`;
    })
    .join("\n");
}

function getInviteLink(code: string): string {
  return botUsername
    ? `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
    : code;
}

async function applyDelay(userId: number): Promise<void> {
  const lastSent = userLastSent.get(userId);
  if (lastSent) {
    const elapsed = Date.now() - lastSent;
    if (elapsed < SEND_DELAY_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, SEND_DELAY_MS - elapsed),
      );
    }
  }

  userLastSent.set(userId, Date.now());
}

function getCommandArgument(text: string | undefined): string {
  if (!text) {
    return "";
  }

  return text.replace(/^\/\S+(?:@\S+)?\s*/s, "").trim();
}

function getStartArgument(text: string | undefined): string {
  return getCommandArgument(text);
}

function extractMediaItem(message: any): MediaItem | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      type: "photo",
      fileId: photo.file_id,
      caption:
        typeof message.caption === "string" && message.caption.trim().length > 0
          ? message.caption.trim()
          : undefined,
    };
  }

  if (message.video?.file_id) {
    return {
      type: "video",
      fileId: message.video.file_id,
      caption:
        typeof message.caption === "string" && message.caption.trim().length > 0
          ? message.caption.trim()
          : undefined,
    };
  }

  if (message.document?.file_id) {
    return {
      type: "document",
      fileId: message.document.file_id,
      caption:
        typeof message.caption === "string" && message.caption.trim().length > 0
          ? message.caption.trim()
          : undefined,
    };
  }

  if (message.video_note?.file_id) {
    return {
      type: "video_note",
      fileId: message.video_note.file_id,
    };
  }

  return null;
}

function buildOutgoingCaption(
  userId: number,
  sourceCaption?: string,
): string | undefined {
  const originalCaption = isCaptionEnabled(userId)
    ? sourceCaption?.trim() || ""
    : "";
  const customCaption = isAddCaptionEnabled(userId)
    ? getCaptionText(userId)
    : "";

  if (originalCaption && customCaption) {
    return `${originalCaption}\n\n${customCaption}`;
  }

  if (originalCaption) {
    return originalCaption;
  }

  if (customCaption) {
    return customCaption;
  }

  return undefined;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function buildMediaGroupPayload(
  items: MediaItem[],
  userId: number,
): Array<{ type: "photo" | "video"; media: string; caption?: string }> {
  const captionIndex = items.findIndex((item) => {
    return (
      (item.type === "photo" || item.type === "video") &&
      Boolean(buildOutgoingCaption(userId, item.caption))
    );
  });

  return items.map((item, index) => {
    if (item.type !== "photo" && item.type !== "video") {
      throw new Error("Only photos and videos can be sent as an album.");
    }

    const payload: {
      type: "photo" | "video";
      media: string;
      caption?: string;
    } = {
      type: item.type,
      media: item.fileId,
    };

    if (index === captionIndex) {
      const caption = buildOutgoingCaption(userId, item.caption);
      if (caption) {
        payload.caption = caption;
      }
    }

    return payload;
  });
}

async function sendSingleMedia(
  chatId: number,
  item: MediaItem,
  userId: number,
  senderName?: string,
): Promise<void> {
  await applyDelay(userId);

  if (senderName) {
    await bot.telegram.sendMessage(chatId, `From ${senderName}`);
  }

  const caption = buildOutgoingCaption(userId, item.caption);

  if (item.type === "photo") {
    await bot.telegram.sendPhoto(chatId, item.fileId, { caption });
    return;
  }

  if (item.type === "video") {
    await bot.telegram.sendVideo(chatId, item.fileId, { caption });
    return;
  }

  if (item.type === "document") {
    await bot.telegram.sendDocument(chatId, item.fileId, { caption });
    return;
  }

  await bot.telegram.sendVideoNote(chatId, item.fileId);
}

async function sendSingleMediaToTargets(
  targetIds: number[],
  item: MediaItem,
  userId: number,
  senderName?: string,
): Promise<void> {
  for (const targetId of targetIds) {
    await sendSingleMedia(targetId, item, userId, senderName);
  }
}

async function sendBufferedItems(
  userId: number,
  senderName?: string,
): Promise<void> {
  const pending = pendingQueues.get(userId);
  if (!pending || pending.items.length === 0) {
    return;
  }

  pendingQueues.delete(userId);

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  const batches = chunkItems(pending.items, 10);

  for (const batch of batches) {
    if (
      batch.length === 1 ||
      batch.some((item) => item.type !== "photo" && item.type !== "video")
    ) {
      for (const targetId of pending.targetIds) {
        if (senderName) {
          await bot.telegram.sendMessage(targetId, `From ${senderName}`);
        }

        for (const item of batch) {
          await sendSingleMedia(targetId, item, userId);
        }
      }
      continue;
    }

    for (const targetId of pending.targetIds) {
      if (senderName) {
        await bot.telegram.sendMessage(targetId, `From ${senderName}`);
      }

      await applyDelay(userId);
      const payload = buildMediaGroupPayload(batch, userId);
      await bot.telegram.sendMediaGroup(targetId, payload);
    }
  }
}

async function sendIncomingMediaGroup(
  groupKey: string,
  senderName?: string,
): Promise<void> {
  const pending = incomingMediaGroups.get(groupKey);
  if (!pending || pending.items.length === 0) return;

  incomingMediaGroups.delete(groupKey);
  if (pending.timer) clearTimeout(pending.timer);

  for (const batch of chunkItems(pending.items, 10)) {
    if (batch.length === 1) {
      await sendSingleMediaToTargets(
        pending.targetIds,
        batch[0],
        pending.userId,
        senderName,
      );
      continue;
    }

    if (batch.some((item) => item.type !== "photo" && item.type !== "video")) {
      for (const targetId of pending.targetIds) {
        if (senderName) {
          await bot.telegram.sendMessage(targetId, `From ${senderName}`);
        }

        for (const item of batch) {
          await sendSingleMedia(targetId, item, pending.userId);
        }
      }
      continue;
    }

    for (const targetId of pending.targetIds) {
      if (senderName) {
        await bot.telegram.sendMessage(targetId, `From ${senderName}`);
      }

      await applyDelay(pending.userId);
      const payload = buildMediaGroupPayload(batch, pending.userId);
      await bot.telegram.sendMediaGroup(targetId, payload);
    }
  }
}

function queueIncomingMediaGroup(
  chatId: number,
  mediaGroupId: string,
  targetIds: number[],
  userId: number,
  item: MediaItem,
  senderName?: string,
): void {
  const groupKey = `${chatId}:${mediaGroupId}`;
  const pending = incomingMediaGroups.get(groupKey) ?? {
    targetIds,
    userId,
    items: [],
    timer: null,
    senderName,
  };

  pending.targetIds = targetIds;
  pending.items.push(item);
  pending.senderName = senderName;

  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(
    () => {
      void sendIncomingMediaGroup(groupKey, pending.senderName).catch(
        (error) => {
          console.error(`Failed to forward media group ${groupKey}:`, error);
        },
      );
    },
    Math.max(SEND_DELAY_MS + 1000, 4000),
  );

  incomingMediaGroups.set(groupKey, pending);
}

function queueMediaItem(
  userId: number,
  chatId: number,
  targetIds: number[],
  item: MediaItem,
  senderName?: string,
): void {
  const pending = pendingQueues.get(userId) ?? {
    chatId,
    targetIds,
    items: [],
    timer: null,
    senderName,
  };

  pending.chatId = chatId;
  pending.targetIds = targetIds;
  pending.items.push(item);
  pending.senderName = senderName;

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    void sendBufferedItems(userId, pending.senderName).catch((error) => {
      console.error(
        `Failed to flush buffered media for user ${userId}:`,
        error,
      );
    });
  }, ALBUM_FLUSH_DELAY_MS);

  pendingQueues.set(userId, pending);
}

function buildWelcomeMessage(userId: number): string {
  return [
    "Welcome!",
    "",
    "Send me photos or videos and I will return them using the bot as the sender.",
    "Album mode is ON by default.",
    "Caption mode is OFF by default.",
    "Sender mode is OFF by default.",
    "",
    `Current status: album mode ${isAlbumModeEnabled(userId) ? "ON" : "OFF"}, caption mode ${isCaptionEnabled(userId) ? "ON" : "OFF"}.`,
    `Custom caption: ${isAddCaptionEnabled(userId) ? `ON (${getCaptionText(userId) || "no text set"})` : "OFF"}`,
    `Sender mode: ${isSenderModeEnabled(userId) ? "ON" : "OFF"}`,
    "",
    "Use /help to see the available commands.",
  ].join("\n");
}

function buildHelpMessage(userId: number): string {
  return [
    "Available commands:",
    "",
    "/start - Show the welcome message.",
    "/album_mode on|off - Enable or disable album mode.",
    "/caption on|off - Enable or disable caption preservation.",
    "/add_caption on|off - Enable or disable the custom caption text.",
    "/caption_text <text> - Set the custom caption text.",
    "/mode_sender on|off - Enable or disable forwarding to your target.",
    "/set_target [user_id] - Set the target user, or choose one from buttons.",
    "/set_multi_target - Select multiple target users.",
    "/get_target - Show the current target.",
    "/change_target <user_id> - Change the target user.",
    "/create_invite <code> - Create an invite code (admin only).",
    "/disable_invite <code> - Disable an invite code (admin only).",
    "/list_invites - List invite codes (admin only).",
    "/stats - List available users (admin only).",
    "/hide <user_id> - Hide a user from target lists (admin only).",
    "/status - Show the current settings.",
    "/help - Show this help message.",
    "",
    `Default settings: album mode ${isAlbumModeEnabled(userId) ? "ON" : "OFF"}, caption mode ${isCaptionEnabled(userId) ? "ON" : "OFF"}.`,
    "",
    "Album mode buffers incoming media for a short time and sends them together when possible.",
    "If only one item is collected, it is sent as a single message.",
    "",
    "Caption mode controls whether the bot keeps the original caption on outgoing media.",
    "Use /caption on to preserve captions, or /caption off to remove them.",
    "",
    "Custom caption mode adds your own text to outgoing media.",
    "Use /add_caption on and then /caption_text <text> to define it.",
    "",
    "Sender mode forwards media to your configured target instead of echoing it back to you.",
  ].join("\n");
}

async function buildStatusMessage(userId: number): Promise<string> {
  const pendingCount = pendingQueues.get(userId)?.items.length ?? 0;
  const targetLabel = await getTargetLabel(userId);

  return [
    "Current bot status:",
    "",
    `Album mode: ${isAlbumModeEnabled(userId) ? "ON" : "OFF"}`,
    `Caption mode: ${isCaptionEnabled(userId) ? "ON" : "OFF"}`,
    `Add caption: ${isAddCaptionEnabled(userId) ? "ON" : "OFF"}`,
    `Caption text: ${getCaptionText(userId) || "not set"}`,
    `Sender mode: ${isSenderModeEnabled(userId) ? "ON" : "OFF"}`,
    `Target: ${targetLabel}`,
    `Buffered media: ${pendingCount}`,
  ].join("\n");
}

async function setMode(
  ctx: Context,
  kind: "album" | "caption" | "add_caption" | "sender",
  enabled: boolean,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (kind === "album") {
    setAlbumModeEnabled(userId, enabled);
  } else if (kind === "caption") {
    setCaptionEnabled(userId, enabled);
  } else if (kind === "sender") {
    setSenderModeEnabled(userId, enabled);
  } else {
    setAddCaptionEnabled(userId, enabled);
  }

  await savePersistedState();
}

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const inviteCode = getStartArgument(message?.text);

  if (inviteCode) {
    if (!mongoReady) {
      await ctx.reply(
        "MongoDB is not connected. Registration is unavailable right now.",
      );
      return;
    }

    const code = normalizeInviteCode(inviteCode);
    const invite = await InviteCodeModel.findOne({
      code,
      isActive: true,
    }).lean();

    if (!invite) {
      await ctx.reply(
        "❌ Invalid invitation code. Try /join <invite_code> if you want to enter it manually.",
      );
      return;
    }

    await syncUserProfile(ctx, { verify: true, inviteCodeUsed: code });
    await InviteCodeModel.updateOne(
      { code },
      {
        $inc: { usesCount: 1 },
        $set: { lastUsedAt: new Date() },
        $addToSet: { usedBy: userId },
      },
    );

    pendingInviteUsers.delete(userId);
    invalidInviteWarnedUsers.delete(userId);

    await ctx.reply(
      `✅ Invitation accepted. Your access is now active.\n\n${buildWelcomeMessage(userId)}`,
    );
    return;
  }

  await ctx.reply(buildWelcomeMessage(userId));
});

bot.command("join", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const inviteCode = getCommandArgument(message?.text);

  if (!inviteCode) {
    await ctx.reply("Usage: /join <invite_code>\nExample: /join MY-CODE-2026");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Registration is unavailable right now.",
    );
    return;
  }

  const code = normalizeInviteCode(inviteCode);
  const invite = await InviteCodeModel.findOne({ code, isActive: true }).lean();

  if (!invite) {
    await ctx.reply("❌ Invalid invitation code. Try again.");
    return;
  }

  await syncUserProfile(ctx, { verify: true, inviteCodeUsed: code });
  await InviteCodeModel.updateOne(
    { code },
    {
      $inc: { usesCount: 1 },
      $set: { lastUsedAt: new Date() },
      $addToSet: { usedBy: userId },
    },
  );

  pendingInviteUsers.delete(userId);
  invalidInviteWarnedUsers.delete(userId);

  await ctx.reply(
    `✅ Invitation accepted. Your access is now active.\n\n${buildWelcomeMessage(userId)}`,
  );
});

bot.command("help", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  await ctx.reply(buildHelpMessage(userId));
});

bot.command("status", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  await ctx.reply(await buildStatusMessage(userId));
});

bot.command("album_mode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const argument = getCommandArgument(message?.text).toLowerCase();

  if (argument === "on") {
    await setMode(ctx, "album", true);
    await ctx.reply(
      "Album mode is now ON. Incoming media will be grouped when possible.",
    );
    return;
  }

  if (argument === "off") {
    await setMode(ctx, "album", false);
    await ctx.reply(
      "Album mode is now OFF. Incoming media will be returned one by one.",
    );
    return;
  }

  await ctx.reply(
    `Album mode is currently ${isAlbumModeEnabled(userId) ? "ON" : "OFF"}.\nUse /album_mode on or /album_mode off.`,
  );
});

bot.command("caption", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const argument = getCommandArgument(message?.text).toLowerCase();

  if (argument === "on") {
    await setMode(ctx, "caption", true);
    await ctx.reply(
      "Caption mode is now ON. Captions will be preserved when possible.",
    );
    return;
  }

  if (argument === "off") {
    await setMode(ctx, "caption", false);
    await ctx.reply(
      "Caption mode is now OFF. Captions will be removed from outgoing media.",
    );
    return;
  }

  await ctx.reply(
    `Caption mode is currently ${isCaptionEnabled(userId) ? "ON" : "OFF"}.\nUse /caption on or /caption off.`,
  );
});

bot.command("mode_sender", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply("MongoDB is not connected. Sender mode is unavailable.");
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const argument = getCommandArgument(message?.text).toLowerCase();

  if (argument === "on") {
    await setMode(ctx, "sender", true);
    await ctx.reply(
      "Sender mode is now ON. Media will be forwarded to your target.",
    );
    return;
  }

  if (argument === "off") {
    await setMode(ctx, "sender", false);
    await ctx.reply(
      "Sender mode is now OFF. Media will be returned in this chat.",
    );
    return;
  }

  await ctx.reply(
    `Sender mode is currently ${isSenderModeEnabled(userId) ? "ON" : "OFF"}.\nUse /mode_sender on or /mode_sender off.`,
  );
});

bot.command("set_target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Target settings are unavailable.",
    );
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const targetArgument = getCommandArgument(message?.text);
  const targetId = Number.parseInt(targetArgument, 10);

  if (!targetArgument) {
    const users = await getSelectableTargets(userId);
    if (!users.length) {
      await ctx.reply("No other verified users are available to select.");
      return;
    }

    await ctx.reply("<b>Select a user to forward media to:</b>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildSingleTargetKeyboard(users) },
    });
    return;
  }

  if (!targetId || Number.isNaN(targetId)) {
    await ctx.reply(
      "Usage: /set_target <user_id>\nExample: /set_target 123456789",
    );
    return;
  }

  if (targetId === userId) {
    await ctx.reply("❌ You cannot set yourself as target.");
    return;
  }

  await setTarget(userId, targetId);
  await ctx.reply(`✅ Target saved successfully.\nTarget: ${targetId}`);
});

bot.action(/^single_target_set_(\d+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!(await isAuthorizedUser(userId))) {
    await ctx.answerCbQuery("Access restricted. Use /join first.", {
      show_alert: true,
    });
    return;
  }

  const targetId = Number((ctx as any).match[1]);
  if (targetId === userId) {
    await ctx.answerCbQuery("You cannot set yourself as target.", {
      show_alert: true,
    });
    return;
  }

  const users = await getSelectableTargets(userId);
  const target = users.find((user) => user.userId === targetId);
  if (!target) {
    await ctx.answerCbQuery("That user is no longer available.", {
      show_alert: true,
    });
    return;
  }

  await setTarget(userId, targetId);
  const displayName = target.firstName || target.username || String(targetId);
  await ctx.editMessageText(
    `Target saved successfully.\n\nTarget: ${displayName}\nID: ${targetId}`,
  );
  await ctx.answerCbQuery("Saved");
});

bot.command("set_multi_target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Target settings are unavailable.",
    );
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) return;

  const users = await getSelectableTargets(userId);
  if (!users.length) {
    await ctx.reply("No other verified users are available to select.");
    return;
  }

  const selected = new Set(await getTargetIds(userId));
  pendingMultiTargetSelections.set(userId, selected);
  await ctx.reply(buildMultiTargetPrompt(selected.size), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buildMultiTargetKeyboard(users, selected),
    },
  });
});

bot.command("change_target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Target settings are unavailable.",
    );
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const targetId = Number.parseInt(getCommandArgument(message?.text), 10);

  if (!targetId || Number.isNaN(targetId)) {
    await ctx.reply(
      "Usage: /change_target <user_id>\nExample: /change_target 123456789",
    );
    return;
  }

  if (targetId === userId) {
    await ctx.reply("❌ You cannot set yourself as target.");
    return;
  }

  await setTarget(userId, targetId);
  await ctx.reply(`✅ Target updated successfully.\nTarget: ${targetId}`);
});

bot.command("get_target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Target settings are unavailable.",
    );
    return;
  }

  if (!(await ensureAuthorizedUser(ctx, userId))) {
    return;
  }

  const target = await getTargetLabel(userId);
  await ctx.reply(`Current target: ${target}`);
});

bot.command("stats", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!isAdminUser(userId)) {
    await ctx.reply("Unauthorized. Admin only.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply("MongoDB is not connected. Stats are unavailable.");
    return;
  }

  const users = await UserModel.find().sort({ createdAt: 1 }).lean();
  const lines = users.map((user, index) => {
    const name = user.firstName || "Unknown";
    const username = user.username ? ` (@${user.username})` : "";
    const hidden = user.hidden ? " [hidden]" : "";
    return `${index + 1}. ${name}${username}${hidden}\n   ID: ${user.userId}`;
  });
  const header = `User stats\nTotal users: ${users.length}`;
  const messages: string[] = [];
  let current = header;

  for (const line of lines) {
    const next = `${current}\n\n${line}`;
    if (next.length > 4000) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  messages.push(current);

  for (const message of messages) {
    await ctx.reply(message);
  }
});

bot.command(["hide", "hide_user"], async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (!isAdminUser(userId)) {
    await ctx.reply("Unauthorized. Admin only.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. User visibility is unavailable.",
    );
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const targetUserId = Number.parseInt(getCommandArgument(message?.text), 10);
  if (!targetUserId || Number.isNaN(targetUserId)) {
    await ctx.reply("Usage: /hide <user_id>\nExample: /hide 123456789");
    return;
  }

  const result = await UserModel.updateOne(
    { userId: targetUserId },
    { $set: { hidden: true } },
  );
  if (!result.matchedCount) {
    await ctx.reply(`User ${targetUserId} was not found.`);
    return;
  }

  await ctx.reply(
    `User ${targetUserId} is now hidden from /set_target and /set_multi_target lists.`,
  );
});

bot.command("create_invite", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Invitation codes are unavailable.",
    );
    return;
  }

  if (!(isAdminUser(userId) || (await isAuthorizedUser(userId)))) {
    await ctx.reply("❌ Unauthorized. Admin only.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const rawCode = getCommandArgument(message?.text);

  if (!rawCode) {
    await ctx.reply(
      "Usage: /create_invite <code>\nExample: /create_invite MY-CODE-2026",
    );
    return;
  }

  const code = normalizeInviteCode(rawCode);

  await InviteCodeModel.updateOne(
    { code },
    { $set: { code, isActive: true, createdBy: userId } },
    { upsert: true },
  );

  await ctx.reply(
    `✅ Invite code created.\nCode: ${code}\nLink: ${getInviteLink(code)}`,
  );
});

bot.command("disable_invite", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Invitation codes are unavailable.",
    );
    return;
  }

  if (!(isAdminUser(userId) || (await isAuthorizedUser(userId)))) {
    await ctx.reply("❌ Unauthorized. Admin only.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const rawCode = getCommandArgument(message?.text);

  if (!rawCode) {
    await ctx.reply(
      "Usage: /disable_invite <code>\nExample: /disable_invite MY-CODE-2026",
    );
    return;
  }

  const code = normalizeInviteCode(rawCode);
  await InviteCodeModel.updateOne({ code }, { $set: { isActive: false } });
  await ctx.reply(`✅ Invite code disabled.\nCode: ${code}`);
});

bot.command("list_invites", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  if (!mongoReady) {
    await ctx.reply(
      "MongoDB is not connected. Invitation codes are unavailable.",
    );
    return;
  }

  if (!(isAdminUser(userId) || (await isAuthorizedUser(userId)))) {
    await ctx.reply("❌ Unauthorized. Admin only.");
    return;
  }

  const invites = await InviteCodeModel.find().sort({ updatedAt: -1 }).lean();
  if (!invites.length) {
    await ctx.reply("No invitation codes found.");
    return;
  }

  const lines = invites.map((invite) => {
    const status = invite.isActive ? "active" : "inactive";
    return `${invite.code} | ${status} | uses: ${invite.usesCount} | ${getInviteLink(invite.code)}`;
  });

  await ctx.reply(`Invitation codes:\n\n${lines.join("\n")}`);
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !pendingInviteUsers.has(userId)) {
    return next();
  }

  const message = ctx.message as { text?: string } | undefined;
  const text = message?.text?.trim();

  if (!text || text.startsWith("/")) {
    return next();
  }

  if (!mongoReady) {
    pendingInviteUsers.delete(userId);
    await ctx.reply(
      "MongoDB is not connected. Registration is unavailable right now.",
    );
    return;
  }

  const code = normalizeInviteCode(text);
  const invite = await InviteCodeModel.findOne({ code, isActive: true }).lean();

  if (!invite) {
    if (!invalidInviteWarnedUsers.has(userId)) {
      invalidInviteWarnedUsers.add(userId);
      await ctx.reply("❌ Invalid invitation code. Try again.");
    }
    return;
  }

  await syncUserProfile(ctx, { verify: true, inviteCodeUsed: code });
  await InviteCodeModel.updateOne(
    { code },
    {
      $inc: { usesCount: 1 },
      $set: { lastUsedAt: new Date() },
      $addToSet: { usedBy: userId },
    },
  );

  pendingInviteUsers.delete(userId);
  invalidInviteWarnedUsers.delete(userId);

  await ctx.reply(
    `✅ Invitation accepted. Your access is now active.\n\n${buildWelcomeMessage(userId)}`,
  );
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId || ctx.chat.type !== "private") {
    return next();
  }

  const message = ctx.message as { text?: string } | undefined;
  const text = message?.text?.trim();

  if (!text || text.startsWith("/")) {
    return next();
  }

  if (!isSenderModeEnabled(userId) && BACKUP_IDS.size === 0) {
    return next();
  }

  if (isSenderModeEnabled(userId)) {
    if (!(await ensureAuthorizedUser(ctx, userId))) {
      return;
    }

    if (!mongoReady) {
      await ctx.reply("MongoDB is not connected. Sender mode is unavailable.");
      return;
    }
  }

  const targetIds = Array.from(
    new Set([
      ...(isSenderModeEnabled(userId) ? await getTargetIds(userId) : []),
      ...BACKUP_IDS,
    ]),
  );
  if (!targetIds.length) {
    await ctx.reply("No target configured. Use /set_target <user_id> first.");
    return;
  }

  for (const targetId of targetIds) {
    await applyDelay(userId);
    await bot.telegram.sendMessage(targetId, text);
  }
});

bot.command("add_caption", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const argument = getCommandArgument(message?.text).toLowerCase();

  if (argument === "on") {
    await setMode(ctx, "add_caption", true);
    await ctx.reply(
      "Custom caption mode is now ON. Use /caption_text <text> to set the caption.",
    );
    return;
  }

  if (argument === "off") {
    await setMode(ctx, "add_caption", false);
    await ctx.reply(
      "Custom caption mode is now OFF. No extra caption will be added.",
    );
    return;
  }

  await ctx.reply(
    `Custom caption mode is currently ${isAddCaptionEnabled(userId) ? "ON" : "OFF"}.\nUse /add_caption on or /add_caption off.`,
  );
});

bot.command("caption_text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("User ID not found.");
    return;
  }

  const message = ctx.message as { text?: string } | undefined;
  const captionText = getCommandArgument(message?.text);

  if (!captionText) {
    await ctx.reply(
      "Usage: /caption_text <text>\nExample: /caption_text My uploaded media",
    );
    return;
  }

  setCaptionText(userId, captionText);
  setAddCaptionEnabled(userId, true);
  await savePersistedState();

  await ctx.reply(
    `Custom caption saved and enabled.\n\nCaption: ${captionText}`,
  );
});

bot.action(/^multi_target_toggle_(\d+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  const selected = userId
    ? pendingMultiTargetSelections.get(userId)
    : undefined;
  if (!userId || !selected) {
    await ctx.answerCbQuery("Start again with /set_multi_target.", {
      show_alert: true,
    });
    return;
  }

  const targetId = Number((ctx as any).match[1]);
  const users = await getSelectableTargets(userId);
  if (!users.some((user) => user.userId === targetId)) {
    await ctx.answerCbQuery("That user is no longer available.", {
      show_alert: true,
    });
    return;
  }

  if (selected.has(targetId)) selected.delete(targetId);
  else selected.add(targetId);

  await ctx.editMessageText(buildMultiTargetPrompt(selected.size), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buildMultiTargetKeyboard(users, selected),
    },
  });
  await ctx.answerCbQuery();
});

bot.action("multi_target_clear", async (ctx) => {
  const userId = ctx.from?.id;
  const selected = userId
    ? pendingMultiTargetSelections.get(userId)
    : undefined;
  if (!userId || !selected) return;

  selected.clear();
  const users = await getSelectableTargets(userId);
  await ctx.editMessageText(buildMultiTargetPrompt(0), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buildMultiTargetKeyboard(users, selected),
    },
  });
  await ctx.answerCbQuery("Selection cleared");
});

bot.action("multi_target_cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) pendingMultiTargetSelections.delete(userId);
  await ctx.editMessageText("❌ Multi-target selection cancelled.");
  await ctx.answerCbQuery();
});

bot.action("multi_target_confirm", async (ctx) => {
  const userId = ctx.from?.id;
  const selected = userId
    ? pendingMultiTargetSelections.get(userId)
    : undefined;
  if (!userId || !selected) {
    await ctx.answerCbQuery("Start again with /set_multi_target.", {
      show_alert: true,
    });
    return;
  }

  const targetIds = Array.from(selected);
  if (!targetIds.length) {
    await ctx.answerCbQuery("Select at least one recipient.", {
      show_alert: true,
    });
    return;
  }

  await setTargets(userId, targetIds);
  pendingMultiTargetSelections.delete(userId);
  await ctx.editMessageText(
    `✅ <b>Recipients configured</b>\n\n${targetIds.map((id, index) => `${index + 1}. <code>${id}</code>`).join("\n")}`,
    { parse_mode: "HTML" },
  );
  await ctx.answerCbQuery("Saved");
});

async function handleIncomingMedia(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    return;
  }

  if (ctx.chat.type !== "private") {
    return;
  }

  const item = extractMediaItem(ctx.message as any);
  if (!item) {
    return;
  }

  const senderModeEnabled = isSenderModeEnabled(userId);
  let targetIds: number[] = [chatId];
  const senderName = ctx.from?.first_name;

  if (senderModeEnabled) {
    if (!(await ensureAuthorizedUser(ctx, userId))) {
      return;
    }

    if (!mongoReady) {
      await ctx.reply("MongoDB is not connected. Sender mode is unavailable.");
      return;
    }

    targetIds = await getTargetIds(userId);

    if (!targetIds.length && BACKUP_IDS.size === 0) {
      await ctx.reply("No target configured. Use /set_target <user_id> first.");
      return;
    }
  }

  targetIds = Array.from(new Set([...targetIds, ...BACKUP_IDS]));

  if (!isAlbumModeEnabled(userId)) {
    const message = ctx.message as { media_group_id?: string } | undefined;
    if (message?.media_group_id) {
      queueIncomingMediaGroup(
        chatId,
        message.media_group_id,
        targetIds,
        userId,
        item,
        senderModeEnabled ? senderName : undefined,
      );
      return;
    }

    await sendSingleMediaToTargets(
      targetIds,
      item,
      userId,
      senderModeEnabled ? senderName : undefined,
    );
    return;
  }

  queueMediaItem(
    userId,
    chatId,
    targetIds,
    item,
    senderModeEnabled ? senderName : undefined,
  );
}

bot.on("photo", handleIncomingMedia);
bot.on("video", handleIncomingMedia);
bot.on("document", handleIncomingMedia);
bot.on("video_note", handleIncomingMedia);

bot.catch((error) => {
  console.error("Bot error:", error);
});

readPersistedState();

function startHealthServer(): void {
  httpServer = http.createServer((request, response) => {
    if (request.url === "/" || request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          bot: botReady ? "ready" : "starting",
          mongo: mongoReady ? "connected" : "unavailable",
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  });

  httpServer.listen(PORT, () => {
    console.log(`HTTP health server listening on port ${PORT}`);
  });
}

async function startBot(): Promise<void> {
  startHealthServer();
  await connectMongo();
  const me = await bot.telegram.getMe();
  botUsername = me.username || "";
  await bot.telegram.setMyCommands(botCommands);
  await bot.launch();
  botReady = true;
  console.log("Anon Sender Bot is running.");
}

void startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

async function stopBot(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  botReady = false;
  bot.stop(signal);

  if (httpServer?.listening) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

process.once("SIGINT", () => void stopBot("SIGINT"));
process.once("SIGTERM", () => void stopBot("SIGTERM"));
