def nric_check(ic):
    if len(ic) != 9 or not ic[1:8].isnumeric():
        return False

    total = sum(int(ic[i]) * int("02765432"[i]) for i in range(1, 8))

    if ic[0] in {"F", "G"}:
        return ic[8] == "XWUTRQPNMLK"[total % 11]
    if ic[0] in {"S", "T"}:
        return ic[8] == "JZIHGFEDCBA"[(total + 4) % 11]

    return False

