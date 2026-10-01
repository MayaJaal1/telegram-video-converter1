import os
import secrets

from telegram import Update
from telegram.ext import Application, ContextTypes, MessageHandler, filters

BOT_TOKEN = os.getenv("BOT_TOKEN")

# अपने channel usernames यहाँ डालो
# उदाहरण: @source_channel
SOURCE_CHANNEL = "@YOUR_SOURCE_CHANNEL"
DESTINATION_CHANNEL = "@YOUR_DESTINATION_CHANNEL"


async def channel_video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.channel_post

    if not message:
        return

    # केवल source channel के posts स्वीकार करो
    if message.chat.username != SOURCE_CHANNEL.lstrip("@"):
        return

    # Video या video document check
    if message.video:
        file_id = message.video.file_id
    elif message.document and message.document.mime_type:
        if not message.document.mime_type.startswith("video/"):
            return
        file_id = message.document.file_id
    else:
        return

    # Unique ID
    video_id = secrets.token_urlsafe(8)

    # अपने channel में video copy करो
    copied = await context.bot.copy_message(
        chat_id=DESTINATION_CHANNEL,
        from_chat_id=message.chat.id,
        message_id=message.message_id
    )

    # अभी testing के लिए link message
    await context.bot.send_message(
        chat_id=DESTINATION_CHANNEL,
        text=(
            "🎬 Video Ready\n\n"
            f"ID: `{video_id}`\n"
            f"Source Message ID: `{copied.message_id}`"
        ),
        parse_mode="Markdown"
    )

    print(f"Video copied: {video_id}")


def main():
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is missing")

    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(
        MessageHandler(
            filters.UpdateType.CHANNEL_POST,
            channel_video
        )
    )

    print("Bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
