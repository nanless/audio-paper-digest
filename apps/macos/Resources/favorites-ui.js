export function favoriteCollectionsWritable(personal){
 const metadata=personal?.favoriteCollections;
 if(metadata==null)return true;
 if(typeof personal.favoriteCollectionsWritable==='boolean')return personal.favoriteCollectionsWritable;
 // Older native bridge snapshots and historical UI fixtures only knew this original shape.
 return metadata.version===1&&!Object.hasOwn(metadata,'contract')&&!Object.hasOwn(metadata,'schemaFingerprint');
}
export function favoriteDate(personal,id){const metadata=personal.favoriteCollections,value=favoriteCollectionsWritable(personal)?metadata?.items?.[id]?.addedAt:null,date=typeof value==='string'?new Date(value):null;return date&&Number.isFinite(date.getTime())?date:null;}
export function favoriteSection(date,grouping='relative',now=new Date()){
 if(!date)return '收藏时间未知';const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);if(date>=tomorrow)return '较晚日期（请检查设备时间）';if(grouping==='month')return `${date.getFullYear()} 年 ${date.getMonth()+1} 月`;const week=new Date(today);week.setDate(week.getDate()-6);return date>=today?'今天收藏':date>=week?'近 7 天收藏':'更早收藏';
}
