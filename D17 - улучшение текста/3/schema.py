from langchain_core.output_parsers import StrOutputParser, PydanticOutputParser
from pydantic import BaseModel, Field, ConfigDict

class EssenceParser(BaseModel):
    essence: str = Field(..., description="Краткая формулировка нарушения")
    norm_doc: str = Field(..., description="Нормативный документ")
    metrics: list[str] = Field(..., description="Массив строк с конкретными цифрами, датами, объемами, сроками из текста")
    
class CausesParser(BaseModel):
    causes: list[str] = Field(..., description="Массив причин")   
    persons: list[str] = Field(..., description="Массив лиц")
    
class ConsequencesParser(BaseModel):
    consequences: str = Field(..., description="Последствия")
    
class MeasuresParser(BaseModel):
    measures: list[str] = Field(..., description="Меры по устранению")
    
class ViolationParser(BaseModel):
    violations: str = Field(..., description="Нарушения")
    causes: str = Field(..., description="Причины")
    consequences: str = Field(..., description="Последствия")
    measures: str = Field(..., description="Принятые меры")
    persons: list[str] = Field(default=[], description="Ответственные лица")

class RecommendationsParser(BaseModel):
    recommendations: list[str] = Field(..., description="Рекомендации")