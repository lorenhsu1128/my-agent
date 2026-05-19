# Install script for directory: C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml

# Set the install prefix
if(NOT DEFINED CMAKE_INSTALL_PREFIX)
  set(CMAKE_INSTALL_PREFIX "C:/Program Files/llama-addon")
endif()
string(REGEX REPLACE "/$" "" CMAKE_INSTALL_PREFIX "${CMAKE_INSTALL_PREFIX}")

# Set the install configuration name.
if(NOT DEFINED CMAKE_INSTALL_CONFIG_NAME)
  if(BUILD_TYPE)
    string(REGEX REPLACE "^[^A-Za-z0-9_]+" ""
           CMAKE_INSTALL_CONFIG_NAME "${BUILD_TYPE}")
  else()
    set(CMAKE_INSTALL_CONFIG_NAME "Release")
  endif()
  message(STATUS "Install configuration: \"${CMAKE_INSTALL_CONFIG_NAME}\"")
endif()

# Set the component getting installed.
if(NOT CMAKE_INSTALL_COMPONENT)
  if(COMPONENT)
    message(STATUS "Install component: \"${COMPONENT}\"")
    set(CMAKE_INSTALL_COMPONENT "${COMPONENT}")
  else()
    set(CMAKE_INSTALL_COMPONENT)
  endif()
endif()

# Is this installation the result of a crosscompile?
if(NOT DEFINED CMAKE_CROSSCOMPILING)
  set(CMAKE_CROSSCOMPILING "FALSE")
endif()

if(NOT CMAKE_INSTALL_LOCAL_ONLY)
  # Include the install script for the subdirectory.
  include("C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/src/cmake_install.cmake")
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY OPTIONAL FILES "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/src/Release/ggml.cuda.spiritbuun_buun-llama-cpp_72d130e.lib")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/bin" TYPE SHARED_LIBRARY FILES "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/bin/Release/ggml.cuda.spiritbuun_buun-llama-cpp_72d130e.dll")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/include" TYPE FILE FILES
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-cpu.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-alloc.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-backend.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-blas.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-cann.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-cpp.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-cuda.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-opt.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-metal.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-rpc.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-virtgpu.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-sycl.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-vulkan.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-webgpu.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-zendnn.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/ggml-openvino.h"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/llama.cpp/ggml/include/gguf.h"
    )
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib" TYPE STATIC_LIBRARY OPTIONAL FILES "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/src/Release/ggml-base.lib")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  if(CMAKE_INSTALL_CONFIG_NAME MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")
    file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/bin" TYPE SHARED_LIBRARY FILES "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/bin/Release/ggml-base.dll")
  endif()
endif()

if(CMAKE_INSTALL_COMPONENT STREQUAL "Unspecified" OR NOT CMAKE_INSTALL_COMPONENT)
  file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/lib/cmake/ggml" TYPE FILE FILES
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/ggml-config.cmake"
    "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/ggml-version.cmake"
    )
endif()

string(REPLACE ";" "\n" CMAKE_INSTALL_MANIFEST_CONTENT
       "${CMAKE_INSTALL_MANIFEST_FILES}")
if(CMAKE_INSTALL_LOCAL_ONLY)
  file(WRITE "C:/Users/LOREN/Documents/_projects/my-agent/vendor/node-llama-tcq/llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_72d130e/llama.cpp/ggml/install_local_manifest.txt"
     "${CMAKE_INSTALL_MANIFEST_CONTENT}")
endif()
