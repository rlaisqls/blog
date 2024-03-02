#!/bin/bash

add_text_to_files() {
    local dir="$1"
    echo "$dir"
    cd "$dir" || exit
    for file in *; do
        if [ -f "$file" ]; then

            # 첫 줄이 h1으로 시작하는 경우 제목이 중복되어 보이므로 삭제
            first_line=$(head -n 1 "$filename")
            if [[ "$first_line" == "# "* ]]; then
                sed -i '1d' "$filename"
            fi

            # title 속성 추가
            filename="${file%.*}"
            echo "---" > tmpfile
            echo "title: '$filename'" >> tmpfile
            echo "---" >> tmpfile
            cat "$file" >> tmpfile
            mv tmpfile "$file"

        elif [ -d "$file" ]; then
            add_text_to_files "$dir/$file"
            cd "$dir"
        fi
    done
}

directory_path="/Users/rlaisqls/Documents/github/starlight/examples/tailwind/src/content/docs/TIL"
add_text_to_files "$directory_path"
