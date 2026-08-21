from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import CurrentUser, get_current_user
from app.deps import get_supabase
from app.schemas import UtilityLogCreate, UtilityLogResponse

router = APIRouter(tags=["utility-logs"])


@router.post("/utility-logs", response_model=UtilityLogResponse)
def create_utility_log(body: UtilityLogCreate, user: CurrentUser = Depends(get_current_user)):
    if body.recorded_by != user.id:
        raise HTTPException(status_code=403, detail="Cannot log a utility reading under another employee's id")

    supabase = get_supabase()
    insert_result = (
        supabase.table("utility_logs")
        .insert(
            {
                "utility_type": body.utility_type,
                "business_date": body.business_date.isoformat(),
                "reading_start": body.reading_start,
                "reading_end": body.reading_end,
                "quantity": body.quantity,
                "unit_label": body.unit_label,
                "days_covered": body.days_covered,
                "unit_cost": body.unit_cost,
                "recorded_by": body.recorded_by,
            }
        )
        .execute()
    )
    return insert_result.data[0]


@router.get("/utility-logs", response_model=list[UtilityLogResponse])
def list_utility_logs(limit: int = Query(50, le=200), user: CurrentUser = Depends(get_current_user)):
    supabase = get_supabase()
    result = supabase.table("utility_logs").select("*").order("created_at", desc=True).limit(limit).execute()
    return result.data
