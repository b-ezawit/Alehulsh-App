export const alertDetailsSchema={type:'object',required:['incidentKey'],additionalProperties:false,minProperties:2,
 properties:{incidentKey:{type:'string',minLength:1,maxLength:128},message:{type:'string',maxLength:4000},isUrgent:{type:'boolean'}}};
export interface AlertDetailsBody{incidentKey:string;message?:string;isUrgent?:boolean}
