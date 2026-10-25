import { describe, it, expect } from 'vitest'
import { ReminderStore } from './reminders'
import { nextOccurrence, resolveReminderTime, validRecurrence } from './reminder-time'

describe('calendar recurrence and finite lifetimes',()=>{
  const at=(year:number,month:number,day:number)=>+new Date(year,month-1,day,9)
  it('keeps the original 31st through February, and leap anniversaries through ordinary years',()=>{
    const rule={frequency:'monthly' as const,day:31,hour:9,minute:0,anchor:at(2026,1,31)}
    expect(nextOccurrence(rule,at(2026,1,31))).toBe(at(2026,2,28))
    expect(nextOccurrence(rule,at(2026,2,28))).toBe(at(2026,3,31))
    const leap={frequency:'yearly' as const,day:29,month:2,hour:9,minute:0,anchor:at(2024,2,29)}
    expect(nextOccurrence(leap,at(2027,2,28))).toBe(at(2028,2,29))
    expect(nextOccurrence(leap,at(2028,2,29))).toBe(at(2029,2,28))
  })
  it('parses complete bounds and rejects malformed calendar dates and quantities',()=>{
    const now=+new Date(2026,9,25,8)
    expect(resolveReminderTime('每月31日上午9点，共3次',now)).toMatchObject({dueAt:at(2026,10,31),recurrence:{frequency:'monthly',day:31,count:3}})
    expect(resolveReminderTime('每年2月29日上午9点',now)).toMatchObject({dueAt:at(2027,2,28),recurrence:{frequency:'yearly',month:2,day:29}})
    expect(resolveReminderTime('每2天上午9点，共3次',now)).toMatchObject({dueAt:at(2026,10,25),recurrence:{frequency:'daily',interval:2,count:3,anchor:at(2026,10,25)}})
    const monthly=resolveReminderTime('每2月1日上午9点',now)
    expect(monthly.dueAt).toBe(at(2026,11,1))
    expect(nextOccurrence(monthly.recurrence!,monthly.dueAt!)).toBe(at(2027,1,1))
    expect(resolveReminderTime('每月32日上午9点',now).dueAt).toBeNull()
    expect(validRecurrence({frequency:'yearly',month:13,day:1,hour:9,minute:0})).toBe(false)
    expect(validRecurrence({frequency:'daily',hour:9,minute:0,count:0})).toBe(false)
  })
  it('does not consume counts on snooze, completes the last occurrence and refuses exhausted restoration',()=>{
    let now=+new Date(2026,9,25,8)
    const store=new ReminderStore(':memory:',()=>now)
    try{
      const row=store.save({title:'Exercise',dueAt:at(2026,10,25),level:'normal',source:'manual',recurrence:{frequency:'daily',hour:9,minute:0,count:2}})
      store.action(row.id,'snooze',5)
      expect(store.get(row.id)?.occurrences).toBe(0)
      const second=store.action(row.id,'complete')
      expect(second).toMatchObject({occurrences:1,status:'pending',dueAt:at(2026,10,26)})
      const reordered={anchor:second.recurrence!.anchor,count:2,minute:0,hour:9,frequency:'daily' as const}
      expect(store.save({...second,title:'Renamed',recurrence:reordered},second.id)).toMatchObject({occurrences:1,status:'pending'})
      now=at(2026,10,26)
      expect(store.action(row.id,'complete')).toMatchObject({occurrences:2,status:'completed'})
      expect(()=>store.action(row.id,'restore')).toThrow('重复提醒已结束')
    }finally{store.close()}
  })
})
