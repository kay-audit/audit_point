from prompt import *
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import StrOutputParser
import os, re, time
import asyncio

LLM_API_BASE = os.getenv("LLM_API_BASE", "http://localhost:30000/v1") #TODO вынести в конфиги
LLM_API_KEY  = os.getenv("LLM_API_KEY", "EMPTY")
MODEL_NAME   = os.getenv("LLM_MODEL", "qwen-3-14b/Qwen_Qwen3-14B/")

def extract_json(text: str):
    text = re.sub(r'<think>.*?<\/think>', '', text, flags=re.DOTALL)
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        return match.group()
    raise ValueError("JSON не найден")

def create_chain(llm, prompt, output_parser):
    return prompt | llm | StrOutputParser() | extract_json | output_parser

async def run_chain(chain, query):
    for  attempt in range(3):
        try: 
            result = await chain.ainvoke(query)
            return result
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"LLM call failed: {e}")
            await asyncio.sleep(2)
            
            
async def orchestrator(query: str):
    llm = ChatOpenAI(model = MODEL_NAME,
                     base_url = LLM_API_BASE,
                     api_key = LLM_API_KEY, 
                    temperature = 0.01)
    params = [(prompt_essence_parser, structed_essence_parser), (prompt_causes_parser, structed_causes_parser), (prompt_consequences_parser, structed_consequences_parser), (prompt_measures_parser, structed_measures_parser)]
    async_chain = [run_chain(create_chain(llm, prompt, parser), query) for prompt, parser in params]
    response_essesence, response_causes, response_consequences, response_measures = await asyncio.gather(*async_chain)
    
    violation_params = {
        "essence": response_essesence.essence,
        "doc_ref": response_essesence.norm_doc,
        "metrics": response_essesence.metrics,
        "persons": response_causes.persons,
        "consequences": response_consequences.consequences,
        "norm_doc": response_essesence.norm_doc,
        "measures": response_measures.measures,
        "causes": response_causes.causes,
    }
    recommendations_params = {
        "essence": response_essesence.essence,
        "norm_doc": response_essesence.norm_doc,
        "metrics": response_essesence.metrics,
        "causes": response_causes.causes,
        "persons": response_causes.persons,
        "consequences": response_consequences.consequences,
        "measures": response_measures.measures,
    }

    chain_violation = create_chain(llm, prompt_violation_parser, structed_violation_parser)
    chain_recommendations = create_chain(
        llm, prompt_recommendations_parser, structed_recommendations_parser)

    final_chain = [
        run_chain(chain_violation, violation_params),
        run_chain(chain_recommendations, recommendations_params),
    ]
    response_violation, response_recommendations = await asyncio.gather(*final_chain)

    return response_violation, response_recommendations

def generate_markdown_report(final_report, recommendations):
    report = f"""
# Итоговый отчёт

## Нарушения:

1. **Нарушение**: {final_report.violations}
2. **Причины**: {final_report.causes}
3. **Ответственные**: {', '.join(final_report.persons) if final_report.persons else 'Не указаны'}
4. **Последствия**: {final_report.consequences}
5. **Принятые меры**: {final_report.measures}

## Рекомендации:
"""

    for i, rec in enumerate(recommendations.recommendations):
        report += f"\n{i+1}. {rec}"
    return report

async def main(query):
    final_report, recommendations = await orchestrator(query)
    return generate_markdown_report(final_report, recommendations)

# print(asyncio.run(main("Какая погода в Москве?")))    
