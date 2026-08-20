import os
from vllm import LLM, SamplingParams
import config
    
os.environ["FLASHINFER_DISABLE_VERSION_CHECK"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"    

"""
Загрузка LLM модели через vLLM

Args:
    model_path: Путь к папке с моделью
    tensor_parallel_size: Количество GPU для параллелизации
    max_model_len: Максимальная длина контекста
    dtype: Тип данных (bfloat16, float16, auto)
    gpu_memory_utilization: Доля GPU памяти для использования
    quantization: Тип квантизации (fp8, awq, squeezellm)

Returns:
    llm: Загруженная модель vLLM
    tokenizer: Токенизатор модели
"""     
# Параметры загрузки
llm_kwargs = {
    "model": config.model_path,
    "tensor_parallel_size": config.tensor_parallel_size,
    "trust_remote_code": config.trust_remote_code,
    "dtype": config.dtype,
    "max_model_len": config.max_model_len,
    "gpu_memory_utilization": config.gpu_memory_utilization,
}

# Добавляем квантизацию если указана
if config.quantization_flg:
    llm_kwargs["quantization"] = config.quantization

try:
    llm = LLM(**llm_kwargs)
    tokenizer = llm.get_tokenizer()

    print(f"✅ Модель успешно загружена:")
    print(f"   - Путь: {config.model_path}")
    print(f"   - Тип данных: {config.dtype}")
    print(f"   - Макс. длина: {config.max_model_len} токенов")
    print(f"   - Параллелизация: {config.tensor_parallel_size} GPU")

except Exception as e:
    print(f"❌ Ошибка загрузки модели: {e}")
    raise
        
# Функция для генерации текста
def generate_response(prompt: str, query: str):
    """
    Генерация ответа от модели
    
    Args:
        llm: Загруженная модель vLLM
        tokenizer: Токенизатор
        prompt: Входной промпт
        temperature: Креативность (0.1 - детерминированно, 1.0 - креативно)
        max_tokens: Максимальная длина ответа
        top_p: Nucleus sampling
        repetition_penalty: Штраф за повторения
        enable_thinking: Включить режим рассуждения Qwen3 (теги <think>)
  
    Returns:
        str: Улучшенный текст.
    """   
    
    # Форматируем промпт для чата (для Qwen3)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": query}
    ]

    formatted_prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=config.enable_thinking  # Отключаем теги <think> если False
    )
    
    # Параметры генерации
    sampling_params = SamplingParams(
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        n=1,
        top_p=config.top_p,
        repetition_penalty=config.repetition_penalty,
        skip_special_tokens=True
    )
    
    # Генерация
    outputs = llm.generate([formatted_prompt], sampling_params)
    response = outputs[0].outputs[0].text.strip()
    
    return response
