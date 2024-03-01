#!/bin/bash

# 함수 정의: 디렉토리 내 파일에 텍스트 추가
add_text_to_files() {
    local dir="$1"
    echo "$dir"
    cd "$dir" || exit
    for file in *; do
        if [ -f "$file" ]; then  # 파일인 경우에만 작업 수행
            filename="${file%.*}"
            echo "---" > tmpfile
            echo "title: '$filename'" >> tmpfile
            echo "---" >> tmpfile
            cat "$file" >> tmpfile
            mv tmpfile "$file"
        elif [ -d "$file" ]; then  # 디렉토리인 경우 재귀적으로 함수 호출
            add_text_to_files "$dir/$file"
            cd "$dir"
        fi
    done
}

directory_path="/Users/rlaisqls/Documents/github/starlight/examples/tailwind/src/content/docs/TIL"
add_text_to_files "$directory_path"
