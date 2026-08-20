import os
import time
import signal
import sys
from datetime import datetime

from editor import generate_response
from analyzer import analyze_text, print_report
import config

# ------------------------------------------------------------
# Конфигурация путей к файлам
# ------------------------------------------------------------
PROMPT_FILE = config.promt_path
QUERY_FILE = config.query_path
OUTPUT_FILE = config.output_path

# ------------------------------------------------------------
# Общая функция обработки (генерация + анализ + сохранение)
# ------------------------------------------------------------
def process(prompt: str, query: str):
    """Принимает готовые prompt и query, генерирует ответ, анализирует, сохраняет."""
    try:
        if not prompt or not query:
            print("⚠️  Один из входных текстов пуст – пропускаем.")
            return

        print("\n" + "=" * 60)
        print(f"🔄 Обработка запроса от {datetime.now().strftime('%H:%M:%S')}")
        print("=" * 60)

        # 2. Диагностика ДО
        print("📊 ДИАГНОСТИКА ДО ПРАВКИ")
        before = analyze_text(query)
        print_report(before)

        # 3. Генерация
        print("✍️  Генерация...")
        improved = generate_response(prompt, query)
        print("✅ Генерация завершена.")

        # 4. Диагностика ПОСЛЕ
        print("\n📊 ДИАГНОСТИКА ПОСЛЕ ПРАВКИ")
        after = analyze_text(improved)
        print_report(after)

        # 5. Сохранение
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            f.write(improved)
        print(f"\n💾 Улучшенный текст сохранён в: {OUTPUT_FILE}")

    except Exception as e:
        print(f"❌ Ошибка при обработке: {e}")

# ------------------------------------------------------------
# Режим 1: мониторинг двух файлов (input_mode = False)
# ------------------------------------------------------------
def run_file_monitoring():
    print("🚀 Запущен режим мониторинга файлов.")
    print(f"   Слежу за: {PROMPT_FILE} и {QUERY_FILE}")
    print("   Редактируйте эти файлы – скрипт автоматически обработает изменения.")
    print("   Для выхода нажмите Ctrl+C.\n")

    try:
        last_prompt_mtime = os.path.getmtime(PROMPT_FILE)
        last_query_mtime = os.path.getmtime(QUERY_FILE)
    except FileNotFoundError as e:
        print(f"❌ Файл не найден: {e.filename}. Создайте его и перезапустите скрипт.")
        return

    while True:
        try:
            current_prompt_mtime = os.path.getmtime(PROMPT_FILE)
            current_query_mtime = os.path.getmtime(QUERY_FILE)

            if (current_prompt_mtime != last_prompt_mtime) or (current_query_mtime != last_query_mtime):
                last_prompt_mtime = current_prompt_mtime
                last_query_mtime = current_query_mtime

                # Читаем оба файла
                with open(PROMPT_FILE, "r", encoding="utf-8") as f:
                    prompt = f.read().strip()
                with open(QUERY_FILE, "r", encoding="utf-8") as f:
                    query = f.read().strip()

                process(prompt, query)

            time.sleep(1)

        except FileNotFoundError as e:
            print(f"⚠️  Файл временно недоступен: {e.filename}. Ждём...")
            time.sleep(2)
        except Exception as e:
            print(f"⚠️  Ошибка в цикле: {e}")
            time.sleep(2)
            
# ------------------------------------------------------------
# Режим 2: интерактивный ввод (input_mode = True)
# ------------------------------------------------------------
def run_interactive():
    print("🚀 Запущен интерактивный режим.")
    print("   Вводите запросы в консоль. Для выхода введите 'exit' или 'quit'.")
    print("   Промпт будет читаться из файла prompt.txt (если существует),")
    print("   или вы можете ввести его отдельно.\n")

    # Загружаем промпт из файла, если он есть
    default_prompt = ""
    if os.path.exists(PROMPT_FILE):
        with open(PROMPT_FILE, "r", encoding="utf-8") as f:
            default_prompt = f.read().strip()
        print(f"📄 Промпт загружен из {PROMPT_FILE} (можно изменить ниже).")

    while True:
        # Запрос у пользователя
        query = input("\nВведите текст для улучшения (или 'exit'): ").strip()
        if query.lower() in ("exit", "quit", "q"):
            print("👋 Выход.")
            break

        if not query:
            print("⚠️  Пустой запрос – пропускаем.")
            continue

        # Спрашиваем, хочет ли пользователь изменить промпт
        change_prompt = input("Изменить системный промпт? (y/N): ").strip().lower()
        if change_prompt == 'y':
            print("Введите новый промпт (завершите ввод пустой строкой или Ctrl+D):")
            lines = []
            while True:
                try:
                    line = input()
                    if line == "":
                        break
                    lines.append(line)
                except EOFError:
                    break
            prompt = "\n".join(lines).strip()
            if not prompt:
                print("⚠️  Промпт пуст, использую предыдущий.")
                prompt = default_prompt
            else:
                default_prompt = prompt  # запоминаем на случай, если не будут менять
        else:
            prompt = default_prompt
            if not prompt:
                print("⚠️  Промпт не задан. Введите его сейчас (пустая строка для завершения):")
                lines = []
                while True:
                    try:
                        line = input()
                        if line == "":
                           break
                        lines.append(line)
                    except EOFError:
                        break
                prompt = "\n".join(lines).strip()
                default_prompt = prompt

        # Обработка
        process(prompt, query)

# ------------------------------------------------------------
# Функция для корректного завершения по Ctrl+C
# ------------------------------------------------------------
def signal_handler(sig, frame):
    print("\n🛑 Завершение работы по запросу пользователя.")
    sys.exit(0)

# ------------------------------------------------------------
# Точка входа
# ------------------------------------------------------------
def main():
    signal.signal(signal.SIGINT, signal_handler)

    # Модель уже загружена при импорте editor.py

    if config.input_mode:
        run_interactive()
    else:
        run_file_monitoring()

if __name__ == "__main__":
    main()
