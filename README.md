# Anon Sender Bot

Telegram bot that receives photos and videos, then republishes them as single media messages or grouped albums.

## Commands

- `/start` - Show the welcome message and current defaults.
- `/album_mode on|off` - Enable or disable album mode. Album mode is on by default.
- `/caption on|off` - Enable or disable caption preservation. Caption mode is off by default.
- `/add_caption on|off` - Enable or disable the custom caption.
- `/caption_text <text>` - Set the custom caption text and enable it.
- `/mode_sender on|off` - Enable or disable forwarding to your target.
- `/set_target [user_id]` - Set the target user ID, or select one with buttons.
- `/set_multi_target` - Select multiple target users with buttons.
- `/get_target` - Show the current target.
- `/change_target <user_id>` - Change the target user ID.
- `/create_invite <code>` - Create an invite code and get a deep link.
- `/disable_invite <code>` - Disable an invite code.
- `/list_invites` - List invite codes.
- `/stats` - List all users (admin only).
- `/hide <user_id>` - Hide a user from target selection lists (admin only).
- `/status` - Show the current mode state.
- `/help` - Show the command list and usage notes.

## Caption Mode

- `/caption on` keeps the original caption when the bot sends the media back.
- `/caption off` removes captions from outgoing media.
- If you send a photo or video without a caption, there is nothing to preserve.

## Custom Caption

- `/add_caption on` enables the custom caption mode.
- `/caption_text <text>` sets the caption text that will be added to outgoing media.
- `/add_caption off` disables the custom caption mode.
- If both caption preservation and custom caption are enabled, the bot combines both texts.

## Behavior

- Media sent to the bot is republished using Telegram file IDs, so the bot does not need to re-upload files.
- When album mode is on, the bot buffers incoming media for a short time and sends them together.
- Albums are split into chunks of up to 10 items.
- When album mode is off, each media item is returned immediately.
- When caption mode is off, captions are stripped from outgoing messages.
- When custom caption mode is on, the bot adds your configured text to outgoing media.
- When sender mode is on, the bot forwards media to your configured target instead of echoing it back.

## Invite Flow

- Set `MONGO_URI` in your `.env` file.
- Create invite codes with `/create_invite <code>`.
- Share the deep link returned by the bot or use `/start <code>` directly.
- Send a valid invite code once to activate a user.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file from `.env.example`.

3. Start the bot:

   ```bash
   npm run dev
   ```

## Notes

- The bot is designed for private chats.
- User-facing text is in English.
