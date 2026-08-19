# ---------- Путь к модели ----------
model_path: str = "/home/datalab/nfs/LLM/IlyaGusev_saiga_llama3_8b"

# ---------- Параметры модели ----------
tensor_parallel_size: int = 1
max_model_len: int = 8192
dtype: str = "auto"
gpu_memory_utilization: float = 0.9
quantization: str = None
enforce_eager: bool = True
trust_remote_code: bool = True

# Квантизация
quantization_flg: bool = False
quantization: str = None

# ---------- Параметры генерации ----------
temperature: float = 0.1
max_tokens: int = 4096
top_p: float = 0.9
repetition_penalty: float = 1.05
enable_thinking: bool = False

# ---------- Параметры запроса ----------
input_mode: bool = False
promt_path: str = "/home/datalab/nfs/d17/Агенты/d17/reading_text/reading_text_test_prompt.txt"
query_path: str = "/home/datalab/nfs/d17/Агенты/d17/reading_text/qwery.txt"
output_path: str = "/home/datalab/nfs/d17/Агенты/d17/reading_text/v2/исправленный_текст.txt"
