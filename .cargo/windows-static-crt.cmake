# Match Rust's +crt-static, including its non-debug CRT in debug builds.
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)

# Legacy MSVC flags are initialized after the toolchain is loaded. Run this
# file again at the compiler-rules hook, preserving every other profile flag.
set(CMAKE_USER_MAKE_RULES_OVERRIDE "${CMAKE_CURRENT_LIST_FILE}")
if(MSVC AND CMAKE_SYSTEM_NAME STREQUAL "Windows")
  foreach(language C CXX)
    foreach(configuration DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
      foreach(suffix "" "_INIT")
        set(flags "CMAKE_${language}_FLAGS_${configuration}${suffix}")
        if(DEFINED ${flags})
          string(REGEX REPLACE "(^|[ \t])[-/](MDd?|MTd)([ \t]|$)" "\\1/MT\\3" static_flags "${${flags}}")
          if(suffix STREQUAL "")
            set(${flags} "${static_flags}" CACHE STRING "MSVC ${configuration} flags" FORCE)
          else()
            set(${flags} "${static_flags}")
          endif()
        endif()
      endforeach()
    endforeach()
  endforeach()
endif()
