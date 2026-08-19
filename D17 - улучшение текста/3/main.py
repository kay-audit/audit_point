import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/home/datalab/nfs/helpers_oarb/mag_datalab_worker/src")

from schemas.task import Task, Answer

from orchestrator import main
warnings.filterwarnings("ignore")

async def main_answer(task: Task):

    answer_text = await main(task.prompt)
    return Answer(text=''.join(answer_text))


if __name__ == "__main__":
    import asyncio
    query = "По результатам проведенной проверки процесса оформления кредитов для субъектов малого и среднего бизнеса (МСБ), выявлены следующие недостатки: в 7% случаев (5 из 30 проверяемых досье) отсутствуют актуальные финансовые отчеты заемщиков, что создает риски принятия неверных решений относительно кредитоспособности клиентов, 10% случаев (3 из 30 проверенных досье) отсутствует обязательная виза риск-менеджера, что нарушает внутренний регламент банка и повышает вероятность выдачи необеспеченых займов. Ответственные: Петров А.В., руководитель отдела кредитования; Сидорова М.И., специалист кредитного отдела."
    result = asyncio.run(main(query))
    print(result)
