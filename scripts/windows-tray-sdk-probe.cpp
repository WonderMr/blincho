#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include <cstddef>
#include <cstdio>

static void pump(DWORD duration) {
    const auto end = GetTickCount64() + duration;
    MSG message{};
    while (GetTickCount64() < end) {
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        Sleep(10);
    }
}

static void probe(const char* name, bool registered, bool callback) {
    const auto instance = GetModuleHandleW(nullptr);
    const auto className = registered ? L"BlinchoSdkProbe" : L"STATIC";
    if (registered) {
        WNDCLASSW cls{};
        cls.lpfnWndProc = DefWindowProcW;
        cls.hInstance = instance;
        cls.lpszClassName = className;
        RegisterClassW(&cls);
    }
    const auto extended = WS_EX_TOOLWINDOW | (registered ? WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED : 0);
    const auto window = CreateWindowExW(extended, className, L"Blincho SDK probe",
        WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
    if (!window) {
        std::printf("%s CreateWindowExW failed=%lu\n", name, GetLastError());
        return;
    }
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = window;
    data.uID = 1;
    data.uFlags = NIF_ICON | NIF_TIP | (callback ? NIF_MESSAGE : 0);
    data.uCallbackMessage = callback ? 6002 : 0;
    data.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    lstrcpyW(data.szTip, L"Blincho SDK probe");
    const auto started = GetTickCount64();
    const auto first = Shell_NotifyIconW(NIM_ADD, &data);
    std::printf("%s window=%p flags=%lu callback=%u add=%d durationMs=%llu\n",
        name, static_cast<void*>(window), data.uFlags, data.uCallbackMessage,
        first, GetTickCount64() - started);
    pump(1000);
    const auto added = first ? first : Shell_NotifyIconW(NIM_ADD, &data);
    std::printf("%s addAfterPump=%d\n", name, added);
    if (added) {
        data.uFlags = NIF_TIP;
        lstrcpyW(data.szTip, L"Blincho SDK probe updated");
        const auto modified = Shell_NotifyIconW(NIM_MODIFY, &data);
        const auto removed = Shell_NotifyIconW(NIM_DELETE, &data);
        std::printf("%s modify=%d delete=%d\n", name, modified, removed);
    }
    DestroyWindow(window);
}

int main() {
    std::printf("SDK pointer=%zu size=%zu hwnd=%zu icon=%zu tip=%zu guid=%zu balloon=%zu\n",
        sizeof(void*), sizeof(NOTIFYICONDATAW), offsetof(NOTIFYICONDATAW, hWnd),
        offsetof(NOTIFYICONDATAW, hIcon), offsetof(NOTIFYICONDATAW, szTip),
        offsetof(NOTIFYICONDATAW, guidItem), offsetof(NOTIFYICONDATAW, hBalloonIcon));
    const auto taskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
    DWORD process = 0;
    const auto thread = GetWindowThreadProcessId(taskbar, &process);
    DWORD_PTR response = 0;
    SetLastError(0);
    const auto responsive = SendMessageTimeoutW(taskbar, WM_NULL, 0, 0,
        SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, 1000, &response);
    const auto error = GetLastError();
    std::printf("taskbar=%p pid=%lu tid=%lu responsive=%lld response=%llu messagingError=%lu\n",
        static_cast<void*>(taskbar), process, thread, static_cast<long long>(responsive),
        static_cast<unsigned long long>(response), error);
    wchar_t desktop[256]{};
    DWORD needed = 0;
    if (GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME,
        desktop, sizeof(desktop), &needed)) std::printf("desktop=%ls\n", desktop);
    probe("A-static-no-message", false, false);
    probe("A2-static-message", false, true);
    probe("B-registered-message", true, true);
    const auto apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    std::printf("STA initialization=%08lx\n", static_cast<unsigned long>(apartment));
    probe("C-registered-message-STA", true, true);
    if (SUCCEEDED(apartment)) CoUninitialize();
    return 0;
}
