import axios, { AxiosError } from "axios";

export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError;
    if (axiosErr.response) {
      switch (axiosErr.response.status) {
        case 404:
          return "Error: API 엔드포인트를 찾을 수 없습니다. KOSCOM 서비스 URL이 변경되었을 수 있습니다.";
        case 500:
          return "Error: KOSCOM 서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
        default:
          return `Error: API 요청 실패 (HTTP ${axiosErr.response.status})`;
      }
    } else if (axiosErr.code === "ECONNABORTED") {
      return "Error: 요청 시간 초과. KOSCOM 서버 응답이 없습니다. 잠시 후 다시 시도해주세요.";
    } else if (axiosErr.code === "ECONNREFUSED") {
      return "Error: KOSCOM 서버에 연결할 수 없습니다. 네트워크 연결을 확인해주세요.";
    } else if (axiosErr.code === "ECONNRESET" || /socket hang up/i.test(axiosErr.message)) {
      return "Error: KOSCOM 서버가 연결을 끊었습니다 (점검/장애 가능성). 잠시 후 다시 시도해주세요.";
    }
  }

  if (error instanceof Error) {
    if (error.message.startsWith("API_ERROR:")) {
      return error.message;
    }
    if (error.message.startsWith("KICPA_UPSTREAM_UNAVAILABLE:")) {
      return `Error: ${error.message.replace(/^KICPA_UPSTREAM_UNAVAILABLE:\s*/, "")}`;
    }
    if (error.message.startsWith("SESSION_ACQUIRE_FAILED")) {
      return "Error: 세션 획득 실패. KOSCOM 서버에서 세션 쿠키를 받지 못했습니다 (서버 점검/장애 가능성). 잠시 후 다시 시도해주세요.";
    }
  }

  return `Error: 예기치 않은 오류 발생: ${error instanceof Error ? error.message : String(error)}`;
}
