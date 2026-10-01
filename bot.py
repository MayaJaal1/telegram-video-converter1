import os
from telegram import Update
from telegram.ext import Application, MessageHandler, ContextTypes, filters

BOT_TOKEN = os.getenv("BOT_TOKEN")

async def receive_video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    video = update.message.video or update.message.document

    await update.message.reply_text(
        f"✅ Video received!\n\n"
        f"File ID:\n`{video.file_id}`\n\n"
        f"Size: {video.file_size} bytes",
        parse_mode="Markdown"
    )

app = Application.builder().token(BOT_TOKEN).build()

app.add_handler(
    MessageHandler(filters.VIDEO | filters.Document.VIDEO, receive_video)
)

print("Bot is running...")
app.run_polling()
