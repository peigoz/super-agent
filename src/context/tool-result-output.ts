import type {ToolResultPart} from 'ai';

type ToolResultOutput = ToolResultPart[ 'output' ];

export function textToolResultOutput(value: string): ToolResultOutput {
  return {type: 'text', value};
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'execution-denied':
      return `[execution-denied] ${output.reason}`;
    case 'content':
      return output.value
        .map(part => {
          switch (part.type) {
            case 'text':
              return part.text
            case 'file':
            case 'file-data':
            case 'image-data':
              return `[media: ${part.mediaType}]`
            case 'file-url':
            case 'image-url':
              return `[file-url: ${part.url}]`
            case 'file-id':
            case 'image-file-id':
              return `[file-id: ${part.fileId}]`
            case 'file-reference':
            case 'image-file-reference':
              return `[file-reference: ${part.providerReference}]`
          }
        })
        .join('\n');
  }
}
