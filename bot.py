import os

from telegram import Update
from telegram.ext import (
    Application,
    ContextTypes,
    MessageHandler,
    filters,
)

BOT_TOKEN = os.getenv("BOT_TOKEN")


async def channel_post(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.channel_post

    if not message:
        return

    # Channel की जानकारी
    chat_id = message.chat.id
    chat_title = message.chat.title

    print(f"CHANNEL NAME: {chat_title}")
    print(f"CHANNEL ID: {chat_id}")

    # Video check
    if message.video:
        print("VIDEO RECEIVED")
        print(f"FILE ID: {message.video.file_id}")

        await context.bot.send_message(
            chat_id=message.chat.id,
            text=(
                "✅ Video detected!\n\n"
                f"Channel: {chat_title}\n"
                f"Channel ID: `{chat_id}`\n"
                f"File ID:\n`{message.video.file_id}`"
            ),
            parse_mode="Markdown",
        )

    elif message.document and message.document.mime_type:
        if message.document.mime_type.startswith("video/"):
            print("VIDEO DOCUMENT RECEIVED")
            print(f"CHANNEL ID: {chat_id}")
            print(f"FILE ID: {message.document.file_id}")


def main():
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is missing")

    app = Application.builder().token(BOT_TOKEN).build()

    # Channel posts
    app.add_handler(
        MessageHandler(
            filters.UpdateType.CHANNEL_POST,
            channel_post
        )
    )

    print("Bot is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
